import { ADAPTER_VERSION, PRIMARY_REGION } from './version.mjs';
import {
  assertExpectedPool,
  assertLaterDay,
  assertNotAliased,
  assertSecondRegion,
  getScenario,
  isFitScenario,
  utcDateString,
} from './scenarios.mjs';
import { fitDateFrom, loadState, updateAdapterState } from './state.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { runRemoteShell } from './aws.mjs';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseMeta(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function buildK6Command(spec, options) {
  const resultsDir = `/opt/cwm-bench/results/raw/${options.campaignId}/${options.runId}`;
  const lines = [
    'set -euo pipefail',
    '# cwm-bench adapter remote execution. Do not print secrets.',
    'if [ -f /opt/cwm-bench/TARGET.env ]; then . /opt/cwm-bench/TARGET.env; fi',
    'cd /opt/cwm-bench',
    `export CAMPAIGN_ID=${shellQuote(options.campaignId)}`,
    `export RUN_ID=${shellQuote(options.runId)}`,
    `export SPLIT=${shellQuote(spec.split)}`,
    `export WARMUP=${shellQuote(options.warmup)}`,
    `export DURATION=${shellQuote(options.duration)}`,
    `export RESULTS_DIR=${shellQuote(resultsDir)}`,
    `export ${spec.workload.envName}=${shellQuote(spec.workload.envValue)}`,
    'mkdir -p "$RESULTS_DIR"',
    'pkill -f "k6 run" >/dev/null 2>&1 || true',
    `k6 run --out json="$RESULTS_DIR/k6.json" load/${spec.workload.script}`,
    'printf "%s\\n" "ADAPTER_RUN_OK"',
    'printf "results_dir=%s\\n" "$RESULTS_DIR"',
  ];
  return lines.join('\n');
}

function teardownCommand() {
  return [
    'set -euo pipefail',
    'pkill -f "k6 run" >/dev/null 2>&1 || true',
    'printf "%s\\n" "ADAPTER_TEARDOWN_OK"',
  ].join('\n');
}

async function readAppMeta(runAws, instanceId, region, ctx) {
  const invocation = await runRemoteShell(runAws, {
    instanceId,
    region,
    commands: ['curl -fsS --max-time 5 http://127.0.0.1:8080/api/meta'],
    timeoutSeconds: 60,
    waitTimeoutMs: ctx.deps.ssmWaitMs || 60_000,
    pollMs: ctx.deps.ssmPollMs || 1000,
    comment: 'cwm-bench read app meta',
    now: ctx.deps.nowMs,
    wait: ctx.deps.wait,
  });
  return parseMeta(invocation.stdout);
}

export async function runScenario(ctx, scenarioKey) {
  const spec = getScenario(scenarioKey);
  assertNotAliased(spec);

  const now = ctx.now();
  const today = utcDateString(now);
  const state = await loadState(ctx.statePath, ctx.deps.fs || {});
  const fitDate = fitDateFrom(state, ctx.env);

  assertLaterDay(spec, now, fitDate);

  const outputs = await readTerraformOutputs(ctx.deps);
  const region = outputs.region || ctx.env.AWS_REGION || PRIMARY_REGION;
  assertSecondRegion(spec, region);

  const runAws = ctx.deps.runAws;
  if (typeof runAws !== 'function') {
    const err = new Error('AWS runner is not configured; cannot execute via SSM');
    err.code = 'AWS_UNAVAILABLE';
    throw err;
  }

  if (spec.expectedPoolSize != null && outputs.appInstanceIds[0]) {
    const meta = await readAppMeta(runAws, outputs.appInstanceIds[0], region, ctx);
    const poolSize = meta && meta.poolSize;
    assertExpectedPool(spec, poolSize);
  }

  const campaignId = ctx.env.CWM_CAMPAIGN_ID || (outputs.topology && outputs.topology.test_id) || 'unset-campaign';
  const runId = ctx.env.CWM_RUN_ID || `${spec.key}-${now.toISOString().replace(/[:.]/g, '')}`;
  const warmup = ctx.env.CWM_WARMUP || '5m';
  const duration = ctx.env.CWM_DURATION || '15m';

  let execution;
  try {
    execution = await runRemoteShell(runAws, {
      instanceId: outputs.generatorInstanceId,
      region,
      commands: [buildK6Command(spec, { campaignId, runId, warmup, duration })],
      timeoutSeconds: Number(ctx.env.CWM_SSM_TIMEOUT || 3600),
      waitTimeoutMs: ctx.deps.ssmWaitMs || Number(ctx.env.CWM_SSM_WAIT_MS || 3600_000),
      pollMs: ctx.deps.ssmPollMs || 2000,
      comment: `cwm-bench run ${spec.key}`,
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
    });
  } finally {
    try {
      await runRemoteShell(runAws, {
        instanceId: outputs.generatorInstanceId,
        region,
        commands: [teardownCommand()],
        timeoutSeconds: 60,
        waitTimeoutMs: ctx.deps.ssmWaitMs || 60_000,
        pollMs: ctx.deps.ssmPollMs || 1000,
        comment: `cwm-bench teardown ${spec.key}`,
        now: ctx.deps.nowMs,
        wait: ctx.deps.wait,
      });
    } catch {
      // Teardown is best-effort; the original error (if any) is more important.
    }
  }

  await updateAdapterState(
    ctx.statePath,
    (next) => {
      if (isFitScenario(spec.key) && !next.fitCampaignDateUtc) {
        next.fitCampaignDateUtc = today;
      }
      next.fitScenarios = Array.isArray(next.fitScenarios) ? next.fitScenarios : [];
      const lastRun = {
        scenario: spec.key,
        runId,
        campaignId,
        at: now.toISOString(),
      };
      next.lastRun = lastRun;
      next.lastRuns = next.lastRuns && typeof next.lastRuns === 'object' ? next.lastRuns : {};
      next.lastRuns[spec.key] = lastRun;
    },
    ctx.deps.fs || {}
  );

  return {
    ok: true,
    adapterVersion: ADAPTER_VERSION,
    scenario: spec.key,
    aliasOf: spec.aliasOf,
    kind: spec.kind,
    rps: spec.rps,
    split: spec.split,
    requiresCompleteCollect: Boolean(spec.requiresCompleteCollect),
    completeness: spec.completeness,
    region,
    regionRole: spec.regionRole,
    calendarDateUtc: today,
    fitCampaignDateUtc: spec.key === 'later-day' ? fitDate : isFitScenario(spec.key) ? today : fitDate,
    campaignId,
    runId,
    commandId: execution.commandId,
    remoteStdout: execution.stdout,
    artifactsHint: `/opt/cwm-bench/results/raw/${campaignId}/${runId}`,
    invented: false,
    teardown: { k6Stopped: true },
  };
}

export { buildK6Command, teardownCommand };
