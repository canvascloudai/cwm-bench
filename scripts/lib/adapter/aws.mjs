import { redact } from './redact.mjs';

function sleep(ms, wait = (n) => new Promise((resolve) => setTimeout(resolve, n))) {
  return wait(ms);
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

export async function awsJson(runAws, args) {
  const result = await runAws(args);
  if (result.code !== 0) {
    const err = new Error(redact(result.stderr || result.stdout || `aws ${args[0]} failed`));
    err.code = 'AWS_CLI_FAILED';
    err.awsArgs = args[0];
    throw err;
  }
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
      const err = new Error(
        redact(
          `SSM command ${status}: ${payload.StandardErrorContent || payload.StatusDetails || status}`
        )
      );
      err.code = 'SSM_EXECUTION_FAILED';
      err.ssmStatus = status;
      err.stdout = redact(payload.StandardOutputContent || '');
      err.stderr = redact(payload.StandardErrorContent || '');
      throw err;
    }
    if (clock() - started > timeoutMs) {
      const err = new Error(`SSM command ${commandId} timed out while ${status || 'pending'}`);
      err.code = 'SSM_TIMEOUT';
      throw err;
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
  return { commandId, ...invocation };
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
  }));
}

export async function getMetricStatistics(runAws, query) {
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
    '--statistics',
    ...(query.statistics || ['Average']),
    '--region',
    query.region,
    '--output',
    'json',
  ];
  if (query.dimensions && query.dimensions.length > 0) {
    args.push('--dimensions', ...query.dimensions);
  }
  const payload = await awsJson(runAws, args);
  return {
    label: query.label || query.metricName,
    namespace: query.namespace,
    metricName: query.metricName,
    dimensions: query.dimensions || [],
    datapoints: metricDatapoints(payload),
    labelFromApi: payload.Label || null,
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
