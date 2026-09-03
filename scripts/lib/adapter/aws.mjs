import { redact } from './redact.mjs';

function sleep(ms, wait = (n) => new Promise((resolve) => setTimeout(resolve, n))) {
  return wait(ms);
}

const DEFAULT_AWS_RETRY_ATTEMPTS = 3;
const DEFAULT_AWS_RETRY_DELAYS_MS = [1000, 3000];

function isRetryableAwsFailure(result) {
  const text = `${result?.stderr || ''} ${result?.stdout || ''}`.toLowerCase();
  return result?.code !== 0 && /throttl|timeout|timed out|temporar|connection reset|service unavailable|internal error|network/.test(text);
}

export function parseJsonOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`${label} returned non-JSON: ${redact(err.message)}`);
    wrapped.code = 'AWS_JSON_INVALID';
    throw wrapped;
  }
}

export async function awsJson(runAws, args, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_AWS_RETRY_ATTEMPTS));
  const retryDelays = options.retryDelays || DEFAULT_AWS_RETRY_DELAYS_MS;
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await runAws(args);
    if (result.code === 0) break;
    if (!isRetryableAwsFailure(result) || attempt >= maxAttempts) {
      const err = new Error(redact(result.stderr || result.stdout || `aws ${args[0]} failed`));
      err.code = 'AWS_CLI_FAILED';
      err.awsArgs = args[0];
      err.attempts = attempt;
      err.retryCount = attempt - 1;
      throw err;
    }
    await sleep(Number(retryDelays[attempt - 1] || retryDelays.at(-1) || 1000), options.wait);
  }
  if (result.code !== 0) throw new Error(`aws ${args[0]} failed after ${maxAttempts} attempts`);
  if (!result.stdout || !String(result.stdout).trim()) {
    return {};
  }
  return parseJsonOrThrow(result.stdout, `aws ${args[0]}`);
}

export async function describeSsmInstance(runAws, instanceId, region) {
  const payload = await awsJson(runAws, [
    'ssm',
    'describe-instance-information',
    '--filters',
    `Key=InstanceIds,Values=${instanceId}`,
    '--region',
    region,
    '--output',
    'json',
  ]);
  const list = payload.InstanceInformationList || [];
  const info = list[0] || null;
  return {
    instanceId,
    reachable: Boolean(info && (info.PingStatus === 'Online' || info.PingStatus === 'online')),
    pingStatus: info ? info.PingStatus : null,
    agentVersion: info ? info.AgentVersion : null,
  };
}

export async function sendShellCommand(runAws, { instanceId, region, commands, timeoutSeconds, comment }) {
  const payload = await awsJson(runAws, [
    'ssm',
    'send-command',
    '--instance-ids',
    instanceId,
    '--document-name',
    'AWS-RunShellScript',
    '--comment',
    comment || 'cwm-bench worker-adapter',
    '--timeout-seconds',
    String(timeoutSeconds || 3600),
    '--parameters',
    JSON.stringify({ commands: Array.isArray(commands) ? commands : [commands] }),
    '--region',
    region,
    '--output',
    'json',
  ]);
  const commandId = payload.Command && payload.Command.CommandId;
  if (!commandId) {
    const err = new Error('SSM send-command returned no CommandId');
    err.code = 'SSM_SEND_FAILED';
    throw err;
  }
  return commandId;
}

export async function waitForInvocation(
  runAws,
  { commandId, instanceId, region, pollMs = 2000, timeoutMs = 3600_000, now, wait }
) {
  const started = (now || Date.now)();
  const clock = now || Date.now;
  for (;;) {
    const payload = await awsJson(runAws, [
      'ssm',
      'get-command-invocation',
      '--command-id',
      commandId,
      '--instance-id',
      instanceId,
      '--region',
      region,
      '--output',
      'json',
    ]);
    const status = payload.Status || payload.status;
    if (status === 'Success') {
      return {
        status,
        stdout: redact(payload.StandardOutputContent || ''),
        stderr: redact(payload.StandardErrorContent || ''),
        responseCode: payload.ResponseCode,
        statusDetails: payload.StatusDetails || null,
        executionStartDateTime: payload.ExecutionStartDateTime || null,
        executionEndDateTime: payload.ExecutionEndDateTime || null,
        commandId,
      };
    }
    if (
      status === 'Failed' ||
      status === 'TimedOut' ||
      status === 'Cancelled' ||
      status === 'Cancelling' ||
      status === 'Undeliverable'
    ) {
      return {
        status,
        ok: false,
        stdout: redact(payload.StandardOutputContent || ''),
        stderr: redact(payload.StandardErrorContent || payload.StatusDetails || status),
        responseCode: payload.ResponseCode,
        statusDetails: payload.StatusDetails || null,
        executionStartDateTime: payload.ExecutionStartDateTime || null,
        executionEndDateTime: payload.ExecutionEndDateTime || null,
        commandId,
      };
    }
    if (clock() - started > timeoutMs) {
      return {
        status: 'TimedOut',
        ok: false,
        stdout: redact(payload.StandardOutputContent || ''),
        stderr: redact(payload.StandardErrorContent || `SSM command ${commandId} timed out while ${status || 'pending'}`),
        responseCode: payload.ResponseCode,
        statusDetails: payload.StatusDetails || null,
        executionStartDateTime: payload.ExecutionStartDateTime || null,
        executionEndDateTime: payload.ExecutionEndDateTime || null,
        commandId,
      };
    }
    await sleep(pollMs, wait);
  }
}

export async function runRemoteShell(runAws, options) {
  const commandId = await sendShellCommand(runAws, options);
  const invocation = await waitForInvocation(runAws, {
    commandId,
    instanceId: options.instanceId,
    region: options.region,
    pollMs: options.pollMs,
    timeoutMs: options.waitTimeoutMs,
    now: options.now,
    wait: options.wait,
  });
  const result = { commandId, ...invocation, ok: invocation.status === 'Success' };
  if (options.throwOnFailure && !result.ok) {
    const err = new Error(redact(`SSM command ${result.status}: ${result.stderr || result.status}`));
    err.code = 'SSM_EXECUTION_FAILED';
    err.ssmStatus = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    err.commandId = result.commandId;
    err.details = {
      statusDetails: result.statusDetails || null,
      responseCode: result.responseCode ?? null,
      executionStartDateTime: result.executionStartDateTime || null,
      executionEndDateTime: result.executionEndDateTime || null,
    };
    throw err;
  }
  return result;
}

function metricDatapoints(payload) {
  const points = Array.isArray(payload.Datapoints) ? payload.Datapoints : [];
  return points.map((point) => ({
    timestamp: point.Timestamp || null,
    average: point.Average ?? null,
    maximum: point.Maximum ?? null,
    minimum: point.Minimum ?? null,
    sum: point.Sum ?? null,
    sampleCount: point.SampleCount ?? null,
    unit: point.Unit || null,
    extendedStatistics:
      point.ExtendedStatistics && typeof point.ExtendedStatistics === 'object'
        ? { ...point.ExtendedStatistics }
        : null,
  }));
}

export async function getMetricStatistics(runAws, query, options = {}) {
  const args = [
    'cloudwatch',
    'get-metric-statistics',
    '--namespace',
    query.namespace,
    '--metric-name',
    query.metricName,
    '--start-time',
    query.startTime,
    '--end-time',
    query.endTime,
    '--period',
    String(query.period || 60),
  ];
  if (query.extendedStatistics && query.extendedStatistics.length > 0) {
    args.push('--extended-statistics', ...query.extendedStatistics);
  } else {
    args.push('--statistics', ...(query.statistics || ['Average']));
  }
  args.push('--region', query.region, '--output', 'json');
  if (query.dimensions && query.dimensions.length > 0) {
    args.push('--dimensions', ...query.dimensions);
  }
  const payload = await awsJson(runAws, args, options);
  return {
    label: query.label || query.metricName,
    namespace: query.namespace,
    metricName: query.metricName,
    dimensions: query.dimensions || [],
    datapoints: metricDatapoints(payload),
    labelFromApi: payload.Label || null,
    extendedStatistics: query.extendedStatistics || null,
  };
}

export function summarizeDatapoints(datapoints, stat) {
  if (!datapoints || datapoints.length === 0) {
    return { available: false, value: null, count: 0 };
  }
  const key = stat || 'average';
  const numbers = datapoints
    .map((point) => point[key])
    .filter((value) => typeof value === 'number');
  if (numbers.length === 0) {
    return { available: false, value: null, count: datapoints.length };
  }
  if (key === 'maximum') {
    return { available: true, value: Math.max(...numbers), count: numbers.length };
  }
  if (key === 'minimum') {
    return { available: true, value: Math.min(...numbers), count: numbers.length };
  }
  if (key === 'sum') {
    return { available: true, value: numbers.reduce((a, b) => a + b, 0), count: numbers.length };
  }
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return { available: true, value: mean, count: numbers.length };
}

export function summarizeExtendedDatapoints(datapoints, percentile) {
  if (!datapoints || datapoints.length === 0) {
    return { available: false, value: null, count: 0, percentile };
  }
  const numbers = datapoints
    .map((point) =>
      point.extendedStatistics && typeof point.extendedStatistics[percentile] === 'number'
        ? point.extendedStatistics[percentile]
        : null
    )
    .filter((value) => typeof value === 'number');
  if (numbers.length === 0) {
    return { available: false, value: null, count: datapoints.length, percentile };
  }
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  return { available: true, value: mean, count: numbers.length, percentile };
}

/** CloudWatch LoadBalancer dimension is the ARN suffix after `loadbalancer/`. */
export function cloudWatchAlbDimension(arn) {
  if (!arn) return null;
  const marker = ':loadbalancer/';
  const idx = String(arn).indexOf(marker);
  return idx >= 0 ? String(arn).slice(idx + marker.length) : null;
}

/** CloudWatch TargetGroup dimension is `targetgroup/` plus the ARN suffix. */
export function cloudWatchTargetGroupDimension(arn) {
  if (!arn) return null;
  const marker = ':targetgroup/';
  const idx = String(arn).indexOf(marker);
  return idx >= 0 ? `targetgroup/${String(arn).slice(idx + marker.length)}` : null;
}
