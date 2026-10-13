// typical-dbsat-v1 collect extras: steady P95 on the generator(s), RDS
// Performance Insights wait events, app pool-wait metrics, and partial-step
// metadata. Every value is read from AWS / the stack; nothing is invented.
// Missing evidence is reported in `missing` so collect stays incomplete and
// the runner re-collects (prereg §7.7).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { awsJson, cloudWatchAlbDimension, getMetricStatistics, runRemoteShell } from './aws.mjs';
import { generatorPlan } from './run.mjs';

const STEADY_SCRIPT = readFileSync(fileURLToPath(new URL('./steady_p95.py', import.meta.url)), 'utf8');

export function steadyCommand(campaignId, runId) {
  const dir = `/opt/cwm-bench/results/raw/${campaignId}/${runId}`;
  const encoded = Buffer.from(STEADY_SCRIPT, 'utf8').toString('base64');
  return [
    'set -euo pipefail',
    `printf '%s' '${encoded}' | base64 -d > /tmp/cwm-steady-p95.py`,
    `printf '%s\\n' '---STEADY_JSON---'`,
    `python3 /tmp/cwm-steady-p95.py ${JSON.stringify(dir)}`,
    `printf '%s\\n' '---END_STEADY_JSON---'`,
    `if [ -f ${JSON.stringify(`${dir}/stopped.json`)} ]; then printf 'STOPPED_JSON=%s\\n' "$(tr -d '\\n' < ${JSON.stringify(`${dir}/stopped.json`)})"; fi`,
  ].join('\n');
}

export function parseSteady(stdout) {
  const text = String(stdout || '');
  const match = text.match(/---STEADY_JSON---\n([\s\S]*?)\n---END_STEADY_JSON---/);
  let steady = null;
  if (match) {
    try {
      steady = JSON.parse(match[1]);
    } catch {
      steady = null;
    }
  }
  const stopMatch = text.match(/^STOPPED_JSON=(.+)$/m);
  let stopped = null;
  if (stopMatch) {
    try {
      stopped = JSON.parse(stopMatch[1]);
    } catch {
      stopped = { reason: 'unparsed' };
    }
  }
  return { steady, stopped };
}

/** Merge per-generator log histograms; nearest rank on bucket upper bounds. */
export function mergeSteady(parts) {
  const present = parts.filter((part) => part && part.present);
  if (present.length === 0) return { present: false };
  if (present.length === 1) {
    return { ...present[0], generators: 1, exact: true };
  }
  const ratio = present[0].logHistogram.ratio;
  const buckets = new Map();
  let total = 0;
  for (const part of present) {
    for (const [key, count] of Object.entries(part.logHistogram.buckets)) {
      buckets.set(Number(key), (buckets.get(Number(key)) || 0) + count);
      total += count;
    }
  }
  const rank = Math.max(1, Math.ceil(0.95 * total));
  let seen = 0;
  let p95 = null;
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    seen += buckets.get(key);
    if (seen >= rank) {
      p95 = ratio ** (key + 1);
      break;
    }
  }
  const minutes = new Map();
  for (const part of present) {
    for (const row of part.perMinute || []) {
      const merged = minutes.get(row.minuteUtc) || { minuteUtc: row.minuteUtc, n: 0, requests: 0, failed: 0, p95MsByGenerator: [] };
      merged.n += row.n;
      merged.requests += row.requests;
      merged.failed += row.failed;
      merged.p95MsByGenerator.push(row.p95Ms);
      minutes.set(row.minuteUtc, merged);
    }
  }
  return {
    present: true,
    generators: present.length,
    exact: false,
    n: total,
    steadyP95Ms: p95,
    droppedIterations: present.reduce((sum, part) => sum + Number(part.droppedIterations || 0), 0),
    method: `merged log histogram (ratio ${ratio}), nearest rank on bucket upper bound`,
    perGenerator: present.map((part) => ({ n: part.n, steadyP95Ms: part.steadyP95Ms })),
    perMinute: [...minutes.values()]
      .sort((a, b) => a.minuteUtc.localeCompare(b.minuteUtc))
      .map((row) => ({ ...row, errorRate: row.requests ? row.failed / row.requests : null })),
  };
}

export async function collectPerformanceInsights(runAws, outputs, region, window) {
  if (!outputs.rdsResourceId) {
    return { available: false, reason: 'terraform output rds_resource_id missing' };
  }
  if (!outputs.performanceInsightsEnabled) {
    return { available: false, reason: 'performance_insights_enabled is false' };
  }
  const payload = await awsJson(runAws, [
    'pi',
    'get-resource-metrics',
    '--service-type', 'RDS',
    '--identifier', outputs.rdsResourceId,
    '--start-time', window.startTime,
    '--end-time', window.endTime,
    '--period-in-seconds', '60',
    '--metric-queries', JSON.stringify([
      { Metric: 'db.load.avg' },
      { Metric: 'db.load.avg', GroupBy: { Group: 'db.wait_event_type' } },
    ]),
    '--region', region,
    '--output', 'json',
  ]);
  const series = (payload.MetricList || []).map((item) => ({
    metric: item.Key && item.Key.Metric,
    dimensions: (item.Key && item.Key.Dimensions) || null,
    datapoints: (item.DataPoints || []).map((point) => ({
      timestamp: point.Timestamp,
      value: point.Value === undefined ? null : point.Value,
    })),
  }));
  return {
    available: series.length > 0,
    identifier: outputs.rdsResourceId,
    periodSeconds: 60,
    alignedStartTime: payload.AlignedStartTime || null,
    alignedEndTime: payload.AlignedEndTime || null,
    series,
  };
}

export async function collectPoolMetrics(runAws, outputs, region, window, deps = {}) {
  const start = Date.parse(window.startTime);
  const end = Date.parse(window.endTime);
  const nodes = [];
  for (const instanceId of outputs.appInstanceIds || []) {
    try {
      const invocation = await runRemoteShell(runAws, {
        instanceId,
        region,
        commands: ['curl -fsS --max-time 5 http://127.0.0.1:8080/api/metrics'],
        timeoutSeconds: 60,
        waitTimeoutMs: deps.ssmWaitMs || 60_000,
        pollMs: deps.ssmPollMs || 1000,
        comment: 'cwm-bench collect pool metrics',
        now: deps.nowMs,
        wait: deps.wait,
        throwOnFailure: true,
      });
      const body = JSON.parse(String(invocation.stdout || '').trim());
      const minutes = (body.minutes || []).filter((row) => {
        const at = Date.parse(row.minute);
        return at >= start && at < end;
      });
      nodes.push({ instanceId, available: minutes.length > 0, gitSha: body.gitSha || null, minutes });
    } catch (error) {
      nodes.push({ instanceId, available: false, error: String(error && error.message ? error.message : error) });
    }
  }
  return { available: nodes.length > 0 && nodes.every((node) => node.available), nodes };
}

/**
 * CloudWatch series §6.3 needs that the shared collect does not query:
 * CPU and NetworkOut on every generator, and ALB TargetConnectionErrorCount.
 */
export async function collectDbsatCloudWatch(runAws, outputs, region, window, options = {}) {
  const queries = [];
  for (const instanceId of outputs.generatorInstanceIds || [outputs.generatorInstanceId]) {
    queries.push({ label: `generator_cpu_${instanceId}`, namespace: 'AWS/EC2', metricName: 'CPUUtilization',
      dimensions: [`Name=InstanceId,Value=${instanceId}`], statistics: ['Average', 'Maximum'] });
    queries.push({ label: `generator_network_out_${instanceId}`, namespace: 'AWS/EC2', metricName: 'NetworkOut',
      dimensions: [`Name=InstanceId,Value=${instanceId}`], statistics: ['Sum'] });
  }
  const albDim = cloudWatchAlbDimension(outputs.albArn);
  if (albDim) {
    queries.push({ label: 'alb_target_connection_errors', namespace: 'AWS/ApplicationELB',
      metricName: 'TargetConnectionErrorCount', dimensions: [`Name=LoadBalancer,Value=${albDim}`], statistics: ['Sum'] });
  }
  const metrics = {};
  const failures = [];
  for (const query of queries) {
    try {
      metrics[query.label] = await getMetricStatistics(runAws, {
        ...query, startTime: window.startTime, endTime: window.endTime, period: 60, region,
      }, { wait: options.wait });
    } catch (error) {
      failures.push({ label: query.label, message: String(error && error.message ? error.message : error) });
    }
  }
  return { metrics, failures };
}

export async function collectDbsatExtras(ctx, spec, outputs, region, window, identity, recorded) {
  const runAws = ctx.deps.runAws;
  const missing = [];
  const parts = [];
  let stopped = null;
  for (const generator of generatorPlan(spec, outputs)) {
    const invocation = await runRemoteShell(runAws, {
      instanceId: generator.instanceId,
      region,
      commands: [steadyCommand(identity.campaignId, identity.runId)],
      timeoutSeconds: 600,
      waitTimeoutMs: ctx.deps.ssmWaitMs || 600_000,
      pollMs: ctx.deps.ssmPollMs || 2000,
      comment: `cwm-bench steady p95 ${spec.key}`,
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
    });
    const parsed = parseSteady(invocation.stdout);
    parts.push(parsed.steady);
    stopped = stopped || parsed.stopped;
  }
  const steady = mergeSteady(parts);
  if (!steady.present) missing.push('dbsat:steadyP95');

  let performanceInsights;
  try {
    performanceInsights = await collectPerformanceInsights(runAws, outputs, region, window);
  } catch (error) {
    performanceInsights = { available: false, error: String(error && error.message ? error.message : error) };
  }
  if (!performanceInsights.available) missing.push('dbsat:performanceInsights');

  const poolMetrics = await collectPoolMetrics(runAws, outputs, region, window, ctx.deps);
  if (!poolMetrics.available) missing.push('dbsat:poolMetrics');

  const extraCloudWatch = await collectDbsatCloudWatch(runAws, outputs, region, window, { wait: ctx.deps.wait });
  if (extraCloudWatch.failures.length > 0) missing.push('dbsat:cloudwatch');

  const partial = Boolean(stopped || (recorded && recorded.partial));
  const steadyMinutes = steady.present ? (steady.perMinute || []).length : 0;
  return {
    missing,
    fields: {
      steadyP95: steady,
      performanceInsights,
      poolMetrics,
      cloudwatch: extraCloudWatch,
      partialStep: {
        partial,
        stepStatus: partial ? 'overload observation' : 'complete',
        stop: stopped,
        steadyMinutesObserved: steadyMinutes,
        label: partial ? `overload, ${steadyMinutes} min` : null,
      },
      generatorInstanceIds: outputs.generatorInstanceIds || [outputs.generatorInstanceId],
      vuAllocation: {
        preSecondsPerRps: Number(ctx.env.CWM_VU_PRE_S || 0.5),
        maxSecondsPerRps: Number(ctx.env.CWM_VU_MAX_S || 2.5),
      },
    },
  };
}
