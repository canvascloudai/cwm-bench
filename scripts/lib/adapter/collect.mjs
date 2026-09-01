import { ADAPTER_VERSION, PRIMARY_REGION } from './version.mjs';
import { getScenario } from './scenarios.mjs';
import { lastRunFrom, loadState } from './state.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import {
  cloudWatchAlbDimension,
  cloudWatchTargetGroupDimension,
  getMetricStatistics,
  runRemoteShell,
  summarizeDatapoints,
} from './aws.mjs';
import {
  assembleRunFields,
  attachAlbPercentiles,
  evaluateCompleteness,
  parseK6Summary,
} from './assemble.mjs';

function parseBoundary(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ceilMinute(value) {
  return new Date(Math.ceil(value.getTime() / 60_000) * 60_000);
}

function floorMinute(value) {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000);
}

function collectionWindow(now, env, persisted) {
  const persistedStart = persisted && persisted.startedAt;
  const persistedEnd = persisted && persisted.endedAt;
  const actualStart = parseBoundary(env.CWM_RUN_STARTED_AT || persistedStart);
  const actualEnd = parseBoundary(env.CWM_RUN_ENDED_AT || persistedEnd);
  if (actualStart && actualEnd) {
    const start = ceilMinute(actualStart);
    const end = floorMinute(actualEnd);
    if (start >= end) {
      const err = new Error('benchmark run has no complete CloudWatch minute within its persisted boundaries');
      err.code = 'RUN_WINDOW_TOO_SHORT';
      throw err;
    }
    return {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      actualStartTime: actualStart.toISOString(),
      actualEndTime: actualEnd.toISOString(),
      source: 'persisted-run',
    };
  }
  const end = now;
  const minutes = Number(env.CWM_COLLECT_WINDOW_MINUTES || 40);
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    actualStartTime: null,
    actualEndTime: null,
    source: 'trailing-fallback',
  };
}

function timestampMs(value) {
  if (typeof value !== 'string') return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function constrainMetricToWindow(metric, window) {
  if (window.source !== 'persisted-run') return metric;
  const start = Date.parse(window.startTime);
  const end = Date.parse(window.endTime);
  return {
    ...metric,
    datapoints: (metric.datapoints || []).filter((point) => {
      const timestamp = timestampMs(point.timestamp);
      return timestamp != null && timestamp >= start && timestamp < end;
    }),
  };
}

function artifactCommand(campaignId, runId) {
  const dir = `/opt/cwm-bench/results/raw/${campaignId}/${runId}`;
  return [
    'set -euo pipefail',
    `DIR=${JSON.stringify(dir)}`,
    'if [ ! -d "$DIR" ]; then printf "%s\\n" "ARTIFACT_DIR_MISSING"; exit 0; fi',
    'printf "ARTIFACT_DIR=%s\\n" "$DIR"',
    'ls -1 "$DIR" || true',
    'if [ -f "$DIR/summary.json" ]; then',
    '  printf "%s\\n" "---SUMMARY_JSON---"',
    '  cat "$DIR/summary.json"',
    '  printf "\\n%s\\n" "---END_SUMMARY_JSON---"',
    'fi',
  ].join('\n');
}

function parseArtifactListing(stdout) {
  const text = String(stdout || '');
  const files = [];
  const dirMatch = text.match(/^ARTIFACT_DIR=(.+)$/m);
  const dir = dirMatch ? dirMatch[1] : null;
  if (text.includes('ARTIFACT_DIR_MISSING')) {
    return { dir: null, files: [], summary: null, present: false };
  }
  const summaryMatch = text.match(/---SUMMARY_JSON---\n([\s\S]*?)\n---END_SUMMARY_JSON---/);
  let summary = null;
  if (summaryMatch) {
    try {
      summary = JSON.parse(summaryMatch[1]);
    } catch {
      summary = null;
    }
  }
  if (dir) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('ARTIFACT_DIR=') ||
        trimmed.startsWith('---') ||
        trimmed === 'ARTIFACT_DIR_MISSING'
      ) {
        continue;
      }
      if (trimmed.includes('{') || trimmed.startsWith('"')) continue;
      files.push(trimmed);
    }
  }
  return { dir, files, summary, present: Boolean(dir), rawListing: text.split('\n').slice(0, 40) };
}

function albQueries(outputs) {
  const albDim = cloudWatchAlbDimension(outputs.albArn);
  const tgDim = cloudWatchTargetGroupDimension(outputs.targetGroupArn);
  if (!albDim) return [];

  const loadBalancer = [`Name=LoadBalancer,Value=${albDim}`];
  const loadBalancerAndTarget = tgDim
    ? [`Name=LoadBalancer,Value=${albDim}`, `Name=TargetGroup,Value=${tgDim}`]
    : loadBalancer;

  return [
    {
      label: 'alb_request_count',
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      dimensions: loadBalancer,
      statistics: ['Sum'],
      summarize: 'sum',
    },
    {
      label: 'alb_http_target_2xx',
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_2XX_Count',
      dimensions: loadBalancerAndTarget,
      statistics: ['Sum'],
      summarize: 'sum',
    },
    {
      label: 'alb_http_target_5xx',
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensions: loadBalancerAndTarget,
      statistics: ['Sum'],
      summarize: 'sum',
    },
    {
      label: 'alb_http_elb_5xx',
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_ELB_5XX_Count',
      dimensions: loadBalancer,
      statistics: ['Sum'],
      summarize: 'sum',
    },
    {
      label: 'alb_target_response_time',
      namespace: 'AWS/ApplicationELB',
      metricName: 'TargetResponseTime',
      dimensions: loadBalancerAndTarget,
      extendedStatistics: ['p50', 'p95', 'p99'],
    },
  ];
}

export async function collectCloudWatch(runAws, outputs, region, window) {
  const queries = [];
  for (const instanceId of outputs.appInstanceIds) {
    queries.push({
      label: `app_cpu_${instanceId}`,
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions: [`Name=InstanceId,Value=${instanceId}`],
      statistics: ['Average'],
      summarize: 'average',
    });
  }
  queries.push({
    label: 'generator_cpu',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: [`Name=InstanceId,Value=${outputs.generatorInstanceId}`],
    statistics: ['Average', 'Maximum'],
    summarize: 'average',
  });
  queries.push({
    label: 'rds_cpu',
    namespace: 'AWS/RDS',
    metricName: 'CPUUtilization',
    dimensions: [`Name=DBInstanceIdentifier,Value=${outputs.rdsIdentifier}`],
    statistics: ['Average'],
    summarize: 'average',
  });
  queries.push({
    label: 'rds_connections',
    namespace: 'AWS/RDS',
    metricName: 'DatabaseConnections',
    dimensions: [`Name=DBInstanceIdentifier,Value=${outputs.rdsIdentifier}`],
    statistics: ['Average', 'Maximum'],
    summarize: 'maximum',
  });
  queries.push({
    label: 'rds_burst_balance',
    namespace: 'AWS/RDS',
    metricName: 'BurstBalance',
    dimensions: [`Name=DBInstanceIdentifier,Value=${outputs.rdsIdentifier}`],
    statistics: ['Minimum'],
    summarize: 'minimum',
  });
  for (const volumeId of outputs.appRootVolumeIds || []) {
    queries.push({
      label: `app_ebs_burst_${volumeId}`,
      namespace: 'AWS/EBS',
      metricName: 'BurstBalance',
      dimensions: [`Name=VolumeId,Value=${volumeId}`],
      statistics: ['Minimum'],
      summarize: 'minimum',
    });
  }
  queries.push(...albQueries(outputs));

  const metrics = {};
  for (const query of queries) {
    const raw = constrainMetricToWindow(await getMetricStatistics(runAws, {
      ...query,
      startTime: window.startTime,
      endTime: window.endTime,
      period: 60,
      region,
    }), window);
    if (query.extendedStatistics) {
      metrics[query.label] = attachAlbPercentiles(raw);
    } else {
      metrics[query.label] = {
        ...raw,
        summary: summarizeDatapoints(raw.datapoints, query.summarize),
      };
    }
  }
  return metrics;
}

export async function collectScenario(ctx, scenarioKey) {
  const spec = getScenario(scenarioKey);
  const outputs = await readTerraformOutputs(ctx.deps);
  const region = outputs.region || ctx.env.AWS_REGION || PRIMARY_REGION;
  const runAws = ctx.deps.runAws;
  if (typeof runAws !== 'function') {
    const err = new Error('AWS runner is not configured; cannot collect CloudWatch or artifacts');
    err.code = 'AWS_UNAVAILABLE';
    throw err;
  }

  const state = await loadState(ctx.statePath, ctx.deps.fs || {});
  const persisted = lastRunFrom(state, ctx.env, spec.key);
  const campaignId =
    ctx.env.CWM_CAMPAIGN_ID ||
    (persisted && persisted.campaignId) ||
    (outputs.topology && outputs.topology.test_id) ||
    'unset-campaign';
  const runId = persisted ? persisted.runId : null;
  const window = collectionWindow(ctx.now(), ctx.env, persisted);

  let cloudwatch;
  try {
    cloudwatch = await collectCloudWatch(runAws, outputs, region, window);
  } catch (err) {
    const wrapped = new Error(err.message || 'CloudWatch collection failed');
    wrapped.code = err.code || 'CLOUDWATCH_COLLECT_FAILED';
    wrapped.cause = err;
    throw wrapped;
  }

  let artifacts = { present: false, dir: null, files: [], summary: null };
  if (runId) {
    const invocation = await runRemoteShell(runAws, {
      instanceId: outputs.generatorInstanceId,
      region,
      commands: [artifactCommand(campaignId, runId)],
      timeoutSeconds: 120,
      waitTimeoutMs: ctx.deps.ssmWaitMs || 120_000,
      pollMs: ctx.deps.ssmPollMs || 1000,
      comment: `cwm-bench collect artifacts ${spec.key}`,
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
    });
    artifacts = parseArtifactListing(invocation.stdout);
  }

  const k6 = parseK6Summary(artifacts.summary);
  const runFields = assembleRunFields({ spec, outputs, cloudwatch, k6 });
  const completeness = evaluateCompleteness({ outputs, cloudwatch, k6 });
  const knownGap = spec.requiresCompleteCollect ? !completeness.complete : false;

  const payload = {
    ok: true,
    adapterVersion: ADAPTER_VERSION,
    scenario: spec.key,
    aliasOf: spec.aliasOf,
    completeness: spec.completeness,
    requiresCompleteCollect: Boolean(spec.requiresCompleteCollect),
    complete: completeness.complete,
    knownGap,
    invented: false,
    campaignId,
    runId,
    runIdSource: persisted ? persisted.source : null,
    region,
    missing: completeness.missing,
    terraformOutputs: {
      alb_dns: outputs.albDns,
      alb_arn: outputs.albArn,
      target_group_arn: outputs.targetGroupArn,
      generator_instance_id: outputs.generatorInstanceId,
      app_instance_ids: outputs.appInstanceIds,
      rds_identifier: outputs.rdsIdentifier,
      rds_endpoint: outputs.rdsEndpoint,
      generator_ip: outputs.generatorIp,
      dashboard_url: outputs.dashboardUrl,
      topology_declaration: outputs.topology,
    },
    resolvedAmis: {
      amiId: outputs.resolvedAmiId,
      source: outputs.amiSource,
      roles: {
        app: outputs.resolvedAmiId,
        generator: outputs.resolvedAmiId,
      },
    },
    cloudwatch: {
      status: 'collected',
      note: 'Values are CloudWatch GetMetricStatistics datapoints. Null/empty means the API returned no datapoints. Nothing here is invented or copied from the public CWM score.',
      window,
      metrics: cloudwatch,
    },
    artifacts: {
      present: artifacts.present,
      dir: artifacts.dir,
      files: artifacts.files,
      summaryPresent: Boolean(artifacts.summary),
      k6,
    },
    latency: runFields.latency,
    albLatency: runFields.albLatency,
    goodputRps: runFields.goodputRps,
    errorCategories: runFields.errorCategories,
    perNode: runFields.perNode,
    databaseConnections: runFields.databaseConnections,
    burstBalanceMin: runFields.burstBalanceMin,
    concurrency: runFields.concurrency,
    iopsThrottle: runFields.iopsThrottle,
  };

  if (spec.requiresCompleteCollect && !completeness.complete) {
    payload.ok = false;
    payload.error = {
      code: 'COLLECT_INCOMPLETE',
      message: `collect for ${spec.key} is incomplete: ${completeness.missing.join(', ') || 'required evidence missing'}. Refusing to treat this as a measured run.`,
    };
  }

  return payload;
}
