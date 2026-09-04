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

const DEFAULT_APP_META_READINESS_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_APP_META_READINESS_POLL_MS = 5 * 1000;
// Status is read through SSM on the same generator running k6. Polling every
// few seconds can overwhelm the SSM agent during long, saturated runs and
// leave later readiness probes unable to execute. The run is detached, so a
// coarser poll is safe and materially reduces command volume.
const DEFAULT_K6_STATUS_POLL_MS = 30 * 1000;
const DEFAULT_K6_STATUS_TIMEOUT_MS = 60 * 60 * 1000;

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
  const identity = JSON.stringify({
    campaignId: options.campaignId,
    runId: options.runId,
    scenario: spec.key,
  });
  const runnerScript = [
    'set +e',
    `k6 run --out json="$RESULTS_DIR/k6.json" load/${spec.workload.script}`,
    'K6_EXIT=$?',
    'printf "%s\\n" "$K6_EXIT" > "$RESULTS_DIR/exit.code"',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$RESULTS_DIR/completed_at"',
    'exit "$K6_EXIT"',
  ].join('\n');
  const lines = [
    'set -euo pipefail',
    '# cwm-bench adapter remote launch. Do not print secrets.',
    '# ADAPTER_K6_START',
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
    'rm -f "$RESULTS_DIR/exit.code" "$RESULTS_DIR/completed_at" "$RESULTS_DIR/pid" "$RESULTS_DIR/started_at" "$RESULTS_DIR/runner.log"',
    `printf '%s\\n' ${shellQuote(identity)} > "$RESULTS_DIR/identity.json"`,
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$RESULTS_DIR/started_at"',
    `nohup setsid sh -c ${shellQuote(runnerScript)} > "$RESULTS_DIR/runner.log" 2>&1 < /dev/null &`,
    'K6_PID=$!',
    'printf "%s\\n" "$K6_PID" > "$RESULTS_DIR/pid"',
    'printf "ADAPTER_K6_STARTED pid=%s\\n" "$K6_PID"',
    'printf "results_dir=%s\\n" "$RESULTS_DIR"',
  ];
  return lines.join('\n');
}

function buildK6StatusCommand(options) {
  const resultsDir = `/opt/cwm-bench/results/raw/${options.campaignId}/${options.runId}`;
  return [
    'set -u',
    '# ADAPTER_K6_STATUS',
    `DIR=${shellQuote(resultsDir)}`,
    'if [ -f "$DIR/exit.code" ]; then',
    '  CODE="$(tr -d "[:space:]" < "$DIR/exit.code")"',
    '  printf "ADAPTER_K6_COMPLETE exit=%s\\n" "$CODE"',
    '  if [ -f "$DIR/completed_at" ]; then printf "completed_at=%s\\n" "$(cat "$DIR/completed_at")"; fi',
    '  tail -n 80 "$DIR/runner.log" 2>/dev/null || true',
    '  exit 0',
    'fi',
    'if [ -f "$DIR/pid" ]; then',
    '  PID="$(tr -d "[:space:]" < "$DIR/pid")"',
    '  if kill -0 "$PID" 2>/dev/null; then',
    '    printf "ADAPTER_K6_RUNNING pid=%s\\n" "$PID"',
    '  else',
    '    printf "ADAPTER_K6_LOST pid=%s (no exit marker)\\n" "$PID"',
    '    tail -n 80 "$DIR/runner.log" 2>/dev/null || true',
    '  fi',
    'else',
    '  printf "%s\\n" "ADAPTER_K6_PENDING"',
    'fi',
  ].join('\n');
}

function teardownCommand(options = {}) {
  if (!options.campaignId || !options.runId) {
    return [
      'set -euo pipefail',
      'printf "%s\\n" "ADAPTER_TEARDOWN_OK (no run directory supplied)"',
    ].join('\n');
  }
  const resultsDir = `/opt/cwm-bench/results/raw/${options.campaignId}/${options.runId}`;
  return [
    'set -u',
    `DIR=${shellQuote(resultsDir)}`,
    'if [ -f "$DIR/exit.code" ]; then',
    '  printf "%s\\n" "ADAPTER_TEARDOWN_OK (k6 already completed)"',
    '  exit 0',
    'fi',
    'if [ -f "$DIR/pid" ]; then',
    '  PID="$(tr -d "[:space:]" < "$DIR/pid")"',
    '  kill -TERM -- "-$PID" >/dev/null 2>&1 || true',
    '  kill -TERM "$PID" >/dev/null 2>&1 || true',
    '  for _ in 1 2 3 4 5; do',
    '    if ! kill -0 "$PID" >/dev/null 2>&1; then break; fi',
    '    sleep 1',
    '  done',
    '  kill -KILL -- "-$PID" >/dev/null 2>&1 || true',
    '  kill -KILL "$PID" >/dev/null 2>&1 || true',
    '  printf "ADAPTER_TEARDOWN_KILLED pid=%s\\n" "$PID"',
    'else',
    '  printf "%s\\n" "ADAPTER_TEARDOWN_OK (k6 was not started)"',
    'fi',
  ].join('\n');
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function appMetaReadinessConfig(ctx) {
  return {
    timeoutMs: positiveNumber(
      ctx.deps.appMetaReadinessTimeoutMs ?? ctx.env.CWM_READINESS_TIMEOUT_MS,
      DEFAULT_APP_META_READINESS_TIMEOUT_MS,
    ),
    pollMs: positiveNumber(
      ctx.deps.appMetaReadinessPollMs ?? ctx.env.CWM_READINESS_POLL_MS,
      DEFAULT_APP_META_READINESS_POLL_MS,
    ),
  };
}

async function readAppMeta(runAws, instanceId, region, ctx) {
  const config = appMetaReadinessConfig(ctx);
  const clock = ctx.deps.nowMs || Date.now;
  const wait = ctx.deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  const deadline = started + config.timeoutMs;
  let attempts = 0;
  let lastError;

  for (;;) {
    attempts += 1;
    try {
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
        throwOnFailure: true,
      });
      const meta = parseMeta(invocation.stdout);
      if (!meta) {
        const error = new Error('app metadata response was not valid JSON');
        error.code = 'APP_META_NOT_READY';
        throw error;
      }
      return meta;
    } catch (error) {
      lastError = error;
      const remainingMs = deadline - clock();
      if (remainingMs <= 0) {
        const timeout = new Error(
          `app metadata did not become ready within ${config.timeoutMs}ms after ` +
          `${attempts} attempt(s): ${lastError?.message || String(lastError)}`,
        );
        timeout.code = 'READINESS_TIMEOUT';
        timeout.phase = 'app-meta';
        timeout.attempts = attempts;
        timeout.lastFailure = String(lastError?.message || lastError);
        throw timeout;
      }
      await wait(Math.min(config.pollMs, remainingMs));
    }
  }
}

function parseK6Status(text) {
  const value = String(text || '');
  const complete = value.match(/ADAPTER_K6_COMPLETE exit=(-?\d+)/);
  if (complete) {
    return { state: 'complete', exitCode: Number(complete[1]) };
  }
  if (value.includes('ADAPTER_K6_LOST')) return { state: 'lost' };
  if (value.includes('ADAPTER_K6_RUNNING')) return { state: 'running' };
  if (value.includes('ADAPTER_K6_PENDING')) return { state: 'pending' };
  return { state: 'unknown' };
}

function k6StatusConfig(ctx) {
  return {
    timeoutMs: positiveNumber(
      ctx.deps.k6RunTimeoutMs ?? ctx.env.CWM_K6_RUN_TIMEOUT_MS ?? ctx.env.CWM_SSM_WAIT_MS,
      DEFAULT_K6_STATUS_TIMEOUT_MS,
    ),
    pollMs: positiveNumber(
      ctx.deps.k6StatusPollMs ?? ctx.env.CWM_K6_STATUS_POLL_MS,
      DEFAULT_K6_STATUS_POLL_MS,
    ),
  };
}

async function waitForK6(ctx, runAws, options) {
  const config = k6StatusConfig(ctx);
  const clock = ctx.deps.nowMs || Date.now;
  const wait = ctx.deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  const deadline = started + config.timeoutMs;
  let attempts = 0;
  let lastFailure = null;

  for (;;) {
    attempts += 1;
    try {
      const invocation = await runRemoteShell(runAws, {
        instanceId: options.instanceId,
        region: options.region,
        commands: [buildK6StatusCommand(options)],
        timeoutSeconds: 60,
        waitTimeoutMs: ctx.deps.ssmWaitMs || 60_000,
        pollMs: ctx.deps.ssmPollMs || 1000,
        comment: `cwm-bench status ${options.scenario}`,
        now: ctx.deps.nowMs,
        wait: ctx.deps.wait,
      });
      if (invocation.status === 'Success') {
        const status = parseK6Status(invocation.stdout);
        if (status.state === 'complete') {
          const ok = status.exitCode === 0;
          return {
            ...invocation,
            ok,
            status: ok ? 'Success' : 'Failed',
            responseCode: status.exitCode,
            pollAttempts: attempts,
          };
        }
        if (status.state === 'lost') {
          return {
            ...invocation,
            ok: false,
            status: 'Failed',
            responseCode: 1,
            stderr: `${invocation.stderr || ''}\nk6 exited without writing an exit marker`,
            pollAttempts: attempts,
          };
        }
        lastFailure = null;
      } else {
        lastFailure = new Error(
          `SSM status command ${invocation.status}: ${invocation.stderr || invocation.status}`,
        );
        lastFailure.ssmStatus = invocation.status;
        lastFailure.details = {
          statusDetails: invocation.statusDetails || null,
          responseCode: invocation.responseCode ?? null,
        };
      }
    } catch (error) {
      lastFailure = error;
    }

    const remainingMs = deadline - clock();
    if (remainingMs <= 0) {
      const timeout = new Error(
        `k6 status did not become terminal within ${config.timeoutMs}ms after ` +
          `${attempts} attempt(s): ${lastFailure?.message || 'status polling timed out'}`,
      );
      timeout.code = 'K6_STATUS_TIMEOUT';
      timeout.attempts = attempts;
      timeout.lastFailure = lastFailure ? String(lastFailure.message || lastFailure) : null;
      throw timeout;
    }
    await wait(Math.min(config.pollMs, remainingMs));
  }
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
    const start = await runRemoteShell(runAws, {
      instanceId: outputs.generatorInstanceId,
      region,
      commands: [buildK6Command(spec, { campaignId, runId, warmup, duration })],
      timeoutSeconds: Number(ctx.env.CWM_SSM_TIMEOUT || 3600),
      waitTimeoutMs: ctx.deps.ssmWaitMs || Number(ctx.env.CWM_SSM_WAIT_MS || 3600_000),
      pollMs: ctx.deps.ssmPollMs || 2000,
      comment: `cwm-bench run ${spec.key}`,
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
      throwOnFailure: true,
    });
    execution = await waitForK6(ctx, runAws, {
      campaignId,
      runId,
      instanceId: outputs.generatorInstanceId,
      region,
      scenario: spec.key,
    });
    execution.startCommandId = start.commandId;
  } finally {
    try {
      await runRemoteShell(runAws, {
        instanceId: outputs.generatorInstanceId,
        region,
        commands: [teardownCommand({ campaignId, runId })],
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

  if (execution.ok) {
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
  }

  return {
    ok: execution.ok,
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
    commandId: execution.startCommandId || execution.commandId,
    statusCommandId: execution.commandId,
    statusPollAttempts: execution.pollAttempts || null,
    commandStatus: execution.status,
    responseCode: execution.responseCode,
    remoteStdout: execution.stdout,
    remoteStderr: execution.stderr,
    error: execution.ok ? null : {
      code: 'SSM_EXECUTION_FAILED',
      message: `benchmark command ended with ${execution.status}`,
    },
    artifactsHint: `/opt/cwm-bench/results/raw/${campaignId}/${runId}`,
    invented: false,
    teardown: { k6Stopped: true },
  };
}

export { buildK6Command, readAppMeta, teardownCommand };
