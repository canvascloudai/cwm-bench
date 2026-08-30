import { ADAPTER_VERSION, PRIMARY_REGION } from './version.mjs';
import { getScenario } from './scenarios.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { getMetricStatistics, runRemoteShell, summarizeDatapoints } from './aws.mjs';

function collectionWindow(now, env) {
  const end = now;
  const minutes = Number(env.CWM_COLLECT_WINDOW_MINUTES || 40);
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
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
  return { dir, files, summary, present: Boolean(dir), rawListing: text.split('\n').slice(0, 40) };
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

  const metrics = {};
  for (const query of queries) {
    const raw = await getMetricStatistics(runAws, {
      ...query,
      startTime: window.startTime,
      endTime: window.endTime,
      period: 60,
      region,
    });
    metrics[query.label] = {
      ...raw,
      summary: summarizeDatapoints(raw.datapoints, query.summarize),
    };
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

  const campaignId = ctx.env.CWM_CAMPAIGN_ID || (outputs.topology && outputs.topology.test_id) || 'unset-campaign';
  const runId = ctx.env.CWM_RUN_ID || null;

  let cloudwatch;
  try {
    cloudwatch = await collectCloudWatch(runAws, outputs, region, collectionWindow(ctx.now(), ctx.env));
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

  return {
    ok: true,
    adapterVersion: ADAPTER_VERSION,
    scenario: spec.key,
    aliasOf: spec.aliasOf,
    knownGap: spec.knownGap,
    invented: false,
    campaignId,
    runId,
    region,
    terraformOutputs: {
      alb_dns: outputs.albDns,
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
      metrics: cloudwatch,
    },
    artifacts,
  };
}
