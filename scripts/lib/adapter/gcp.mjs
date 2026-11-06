import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTER_VERSION } from './version.mjs';
import { redact } from './redact.mjs';
import {
  assertExpectedAppCount,
  assertExpectedPool,
  assertExpectedProfile,
  assertNotAliased,
} from './scenarios.mjs';
import { requireRunIdentity } from './identity.mjs';
import { assertLadderPosition, ladderHistory, resolveLadder } from './ladder.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { loadState, updateAdapterState } from './state.mjs';
import {
  GCP_BACKEND_HEALTH_POLL_MS,
  GCP_BACKEND_HEALTH_SUSTAINED_MS,
  GCP_BACKEND_HEALTH_TIMEOUT_MS,
  backendsFromHealthResponse,
  waitForBackendHealth,
} from './gcp-backend-health.mjs';

export {
  GCP_BACKEND_HEALTH_POLL_MS,
  GCP_BACKEND_HEALTH_SUSTAINED_MS,
  GCP_BACKEND_HEALTH_TIMEOUT_MS,
};

async function appMeta(stdout) {
  const ready = await import('./ready.mjs');
  return ready.metaFromStdout(stdout);
}

/**
 * GCP client and gcp-fit-v1 run/collect path.
 * AWS commands never call these functions. Adapter 1.7.2 changed only the GCP CLI transport (see gcp-cli.mjs).
 * Adapter 1.7.4 adds a pre-load backend-health gate before k6 starts.
 */

export const GCP_FIT_REGION = 'us-central1';
export const GCP_FIT_LADDER = Object.freeze([200, 400, 600]);
export const GCP_FIT_WARMUP = '300s';
export const GCP_FIT_DURATION = '900s';
export const GCP_FIT_SPEND_CAP_USD = 60;
export const GCP_FIT_MAX_REPLACEMENTS = 3;
export const GCP_FIT_TEST_ID_RE = /^gcp-fit-v1-r[12][a-c]?-\d{8}$/;
export const GCP_HOLDOUT_TEST_ID_RE = /^gcp-holdout-v1-r[12][a-c]?-\d{8}$/;

const STEADY_SCRIPT = readFileSync(fileURLToPath(new URL('./steady_p95.py', import.meta.url)), 'utf8');

const ERROR_CLASSES = Object.freeze([
  'db_timeout',
  'too_many_connections',
  'queue_full',
  'cpu_overload',
  'internal',
  'unclassified',
]);

function sleep(ms, wait = (n) => new Promise((resolve) => setTimeout(resolve, n))) {
  return wait(ms);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isRetryable(result) {
  const text = `${result?.stderr || ''} ${result?.stdout || ''}`.toLowerCase();
  return result?.code !== 0 && /throttl|timeout|timed out|temporar|connection reset|unavailable|internal error|network/.test(text);
}

export async function gcloudJson(runGcloud, args, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const retryDelays = options.retryDelays || [1000, 3000];
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await runGcloud(args);
    if (result.code === 0) break;
    if (!isRetryable(result) || attempt >= maxAttempts) {
      const err = new Error(redact(result.stderr || result.stdout || 'gcloud failed'));
      err.code = 'GCP_CLI_FAILED';
      err.attempts = attempt;
      throw err;
    }
    await sleep(Number(retryDelays[attempt - 1] || 1000), options.wait);
  }
  if (!result.stdout || !String(result.stdout).trim()) return [];
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    const wrapped = new Error(`gcloud returned non-JSON: ${redact(err.message)}`);
    wrapped.code = 'GCP_JSON_INVALID';
    throw wrapped;
  }
}

export async function runRemoteShell(runGcloud, { name, zone, project, command }) {
  if (!name || !zone || !project) {
    const err = new Error('gcloud compute ssh needs generator_name, generator_zone, and project_id outputs');
    err.code = 'GCP_SSH_TARGET_MISSING';
    throw err;
  }
  const result = await runGcloud([
    'compute', 'ssh', name,
    '--zone', zone,
    '--project', project,
    '--quiet',
    '--tunnel-through-iap',
    '--command', command,
  ]);
  if (result.code !== 0) {
    const err = new Error(redact(result.stderr || result.stdout || 'gcloud compute ssh failed'));
    err.code = 'GCP_SSH_FAILED';
    throw err;
  }
  return {
    stdout: result.stdout || '',
    stderr: redact(result.stderr || ''),
  };
}

export function vmCpuFilter(role, testId) {
  return [
    'metric.type="compute.googleapis.com/instance/cpu/utilization"',
    `metadata.user_labels.role="${role}"`,
    `metadata.user_labels.test_id="${testId}"`,
  ].join(' AND ');
}

export function sqlMetricFilter(metric, instanceName) {
  return [
    `metric.type="cloudsql.googleapis.com/database/${metric}"`,
    `resource.labels.database_id=monitoring.regex.full_match(".*:${instanceName}")`,
  ].join(' AND ');
}

export function assertBillingTable(table) {
  if (typeof table !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_*-]+$/.test(table)) {
    const err = new Error('CWM_GCP_BILLING_EXPORT_TABLE must be project.dataset.table');
    err.code = 'GCP_BILLING_TABLE_INVALID';
    throw err;
  }
  return table;
}

export function billingSql(table, project, start, end) {
  assertBillingTable(table);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project || '')) {
    const err = new Error('billing query project id is not a project id');
    err.code = 'GCP_PROJECT_MISSING';
    throw err;
  }
  for (const stamp of [start, end]) {
    if (Number.isNaN(Date.parse(stamp))) {
      const err = new Error('billing query window is not ISO-8601');
      err.code = 'RUN_WINDOW_MISSING';
      throw err;
    }
  }
  return [
    'SELECT SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost',
    `FROM \`${table}\``,
    `WHERE usage_start_time < TIMESTAMP("${end}")`,
    `AND usage_end_time > TIMESTAMP("${start}")`,
    `AND project.id = "${project}"`,
  ].join(' ');
}

export function spendCapDecision(spentUsd, capUsd = GCP_FIT_SPEND_CAP_USD) {
  const spent = Number(spentUsd);
  if (!Number.isFinite(spent)) {
    return { action: 'pause', autoStop: false, ask: true, reason: 'billed spend is not a number' };
  }
  if (spent >= capUsd) {
    return {
      action: 'pause',
      autoStop: false,
      ask: true,
      reason: `billed spend ${spent} USD reached the ${capUsd} USD cap`,
    };
  }
  return { action: 'continue', autoStop: false, ask: false, reason: 'under cap' };
}

export function replacementDecision({ faultClass, replacementsUsed, errorCode } = {}) {
  if (errorCode === 'GCP_BACKEND_HEALTH_TIMEOUT') {
    faultClass = 'runner';
  }
  const used = Number(replacementsUsed || 0);
  if (faultClass !== 'runner') {
    return {
      replaceApply: false,
      scope: null,
      autoStop: false,
      ask: false,
      reason: 'only a runner fault replaces the apply',
    };
  }
  if (used >= GCP_FIT_MAX_REPLACEMENTS) {
    return {
      replaceApply: false,
      scope: 'whole-apply',
      autoStop: false,
      ask: true,
      reason: 'replacement cap reached',
    };
  }
  return {
    replaceApply: true,
    scope: 'whole-apply',
    autoStop: false,
    ask: false,
    reason: errorCode === 'GCP_BACKEND_HEALTH_TIMEOUT'
      ? 'pre-rung backend health timeout replaces the whole apply'
      : 'runner fault replaces the whole apply',
    nextIndex: used + 1,
    ...(errorCode === 'GCP_BACKEND_HEALTH_TIMEOUT' ? { preRung: true } : {}),
  };
}

function pointValue(point) {
  const value = point && point.value ? point.value : {};
  const raw = value.doubleValue != null ? Number(value.doubleValue) : value.int64Value != null ? Number(value.int64Value) : null;
  return Number.isFinite(raw) ? raw : null;
}

export function averageRatioPercent(seriesList) {
  const grouped = new Map();
  for (const series of seriesList || []) {
    const labels = (series.resource && series.resource.labels) || {};
    const id = labels.instance_id || 'unknown';
    const values = [];
    for (const point of series.points || []) {
      const raw = pointValue(point);
      if (raw == null) continue;
      // Cloud Monitoring CPU utilization is a ratio in [0, 1].
      values.push(raw * 100);
    }
    if (!values.length) continue;
    grouped.set(String(id), values.reduce((sum, item) => sum + item, 0) / values.length);
  }
  return grouped;
}

export function connectionStats(seriesList) {
  const values = [];
  for (const series of seriesList || []) {
    for (const point of series.points || []) {
      const raw = pointValue(point);
      if (raw != null) values.push(raw);
    }
  }
  if (!values.length) return { avg: null, max: null };
  return {
    avg: values.reduce((sum, item) => sum + item, 0) / values.length,
    max: Math.max(...values),
  };
}

function vuBudget(rps) {
  if (rps <= 100) return { preAllocatedVUs: 80, maxVUs: 200 };
  if (rps <= 500) return { preAllocatedVUs: 400, maxVUs: 800 };
  return { preAllocatedVUs: 800, maxVUs: 1600 };
}

function gcpFields(outputs) {
  const raw = outputs.raw || {};
  const topology = outputs.topology || {};
  return {
    project: raw.project_id || null,
    zone: raw.generator_zone || topology.zone || null,
    generatorName: raw.generator_name || null,
    sqlName: raw.sql_instance_name || outputs.rdsIdentifier || null,
    testId: topology.test_id || null,
    image: outputs.resolvedAmiId || null,
  };
}

export function assertGcpFitIdentity(spec, env, outputs) {
  const fromEnv = env && env.CWM_CAMPAIGN_ID ? String(env.CWM_CAMPAIGN_ID) : '';
  const fromTf = outputs && outputs.topology && outputs.topology.test_id
    ? String(outputs.topology.test_id)
    : '';
  if (fromEnv && fromTf && fromEnv !== fromTf) {
    const err = new Error(`CWM_CAMPAIGN_ID ${fromEnv} does not match terraform test_id ${fromTf}`);
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
  const id = fromEnv || fromTf;
  const holdout = spec.split === 'holdout';
  const idPattern = holdout ? GCP_HOLDOUT_TEST_ID_RE : GCP_FIT_TEST_ID_RE;
  const idFamily = holdout ? 'gcp-holdout-v1' : 'gcp-fit-v1';
  if (!idPattern.test(id)) {
    const err = new Error(
      `scenario ${spec.key} requires test id ${idFamily}-r{1|2}[a-c]-YYYYMMDD; got ${id || 'unset'}`,
    );
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
  const region = outputs && (outputs.region || (outputs.topology && outputs.topology.region));
  if (region !== GCP_FIT_REGION) {
    const err = new Error(`scenario ${spec.key} requires Terraform region ${GCP_FIT_REGION}; resolved ${region || 'unset'}`);
    err.code = 'GCP_REGION_CONSTRAINT';
    throw err;
  }
  if (!outputs || !outputs.topology || outputs.topology.cloud !== 'gcp') {
    const err = new Error(`scenario ${spec.key} requires topology.cloud=gcp`);
    err.code = 'GCP_TOPOLOGY_MISMATCH';
    throw err;
  }
  if (outputs.topology.app_instance_type && outputs.topology.app_instance_type !== 'n2-standard-2') {
    const err = new Error(`gcp-fit-v1 app machine type must be n2-standard-2; got ${outputs.topology.app_instance_type}`);
    err.code = 'GCP_TOPOLOGY_MISMATCH';
    throw err;
  }
  if (outputs.topology.db_instance_class && outputs.topology.db_instance_class !== 'db-custom-2-13312') {
    const err = new Error(`gcp-fit-v1 Cloud SQL tier must be db-custom-2-13312; got ${outputs.topology.db_instance_class}`);
    err.code = 'GCP_TOPOLOGY_MISMATCH';
    throw err;
  }
  return id;
}

function assertTiming(spec, env) {
  const warmup = env.CWM_WARMUP || spec.warmup;
  const duration = env.CWM_DURATION || spec.duration;
  if (warmup !== spec.warmup || duration !== spec.duration) {
    const err = new Error(
      `gcp-fit timing is ${spec.warmup} warmup and ${spec.duration} steady; got ${warmup} / ${duration}`,
    );
    err.code = 'TIMING_MISMATCH';
    throw err;
  }
  return { warmup, duration };
}

function requireGcloud(ctx) {
  if (typeof ctx.deps.runGcloud !== 'function') {
    const err = new Error('gcloud runner is not configured');
    err.code = 'GCP_UNAVAILABLE';
    throw err;
  }
  return ctx.deps.runGcloud;
}

function steadyCommand(campaignId, runId) {
  const dir = `/opt/cwm-bench/results/raw/${campaignId}/${runId}`;
  const encoded = Buffer.from(STEADY_SCRIPT, 'utf8').toString('base64');
  return [
    'set -euo pipefail',
    `printf '%s' '${encoded}' | base64 -d > /tmp/cwm-steady-p95.py`,
    `printf '%s\\n' '---STEADY_JSON---'`,
    `python3 /tmp/cwm-steady-p95.py ${JSON.stringify(dir)}`,
    `printf '%s\\n' '---END_STEADY_JSON---'`,
  ].join('\n');
}

function parseSteady(stdout) {
  const text = String(stdout || '');
  const match = text.match(/---STEADY_JSON---\n([\s\S]*?)\n---END_STEADY_JSON---/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function metaCommand() {
  return [
    'set -euo pipefail',
    'if [ -f /opt/cwm-bench/TARGET.env ]; then . /opt/cwm-bench/TARGET.env; fi',
    'test -n "${TARGET:-}"',
    'curl -fsS --max-time 10 "$TARGET/health"',
    'curl -fsS --max-time 10 "$TARGET/api/meta"',
  ].join('\n');
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
    'if [ -f "$RESULTS_DIR/k6.json" ]; then gzip -nf "$RESULTS_DIR/k6.json"; fi',
    'printf "%s\\n" "$K6_EXIT" > "$RESULTS_DIR/exit.code"',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$RESULTS_DIR/completed_at"',
    'exit "$K6_EXIT"',
  ].join('\n');
  return [
    'set -euo pipefail',
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
    `printf '%s\\n' ${shellQuote(identity)} > "$RESULTS_DIR/identity.json"`,
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$RESULTS_DIR/started_at"',
    `nohup setsid sh -c ${shellQuote(runnerScript)} > "$RESULTS_DIR/runner.log" 2>&1 < /dev/null &`,
    'K6_PID=$!',
    'printf "%s\\n" "$K6_PID" > "$RESULTS_DIR/pid"',
    'printf "ADAPTER_K6_STARTED pid=%s\\n" "$K6_PID"',
  ].join('\n');
}

function statusCommand(campaignId, runId) {
  const dir = `/opt/cwm-bench/results/raw/${campaignId}/${runId}`;
  return [
    'set -u',
    '# ADAPTER_K6_STATUS',
    `DIR=${shellQuote(dir)}`,
    'if [ -f "$DIR/exit.code" ]; then',
    '  CODE="$(tr -d "[:space:]" < "$DIR/exit.code")"',
    '  printf "ADAPTER_K6_COMPLETE exit=%s\\n" "$CODE"',
    '  exit 0',
    'fi',
    'printf "%s\\n" "ADAPTER_K6_RUNNING"',
  ].join('\n');
}

function requireWindow(env) {
  const start = env.CWM_RUN_STARTED_AT;
  const end = env.CWM_RUN_ENDED_AT;
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!start || !end || Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    const err = new Error('gcp-fit collect requires CWM_RUN_STARTED_AT and CWM_RUN_ENDED_AT covering the steady window');
    err.code = 'RUN_WINDOW_MISSING';
    throw err;
  }
  return { start, end, startMs, endMs };
}

async function monitoringQuery(runGcloud, project, filter, window) {
  return gcloudJson(runGcloud, [
    'monitoring', 'time-series', 'list',
    `--project=${project}`,
    `--filter=${filter}`,
    `--interval-start-time=${window.start}`,
    `--interval-end-time=${window.end}`,
    '--format=json',
  ]);
}

function attestedSha(meta, env) {
  const fromMeta = meta && typeof meta.gitSha === 'string' ? meta.gitSha.trim().toLowerCase() : '';
  const fromEnv = env.CWM_MEASUREMENT_SHA ? String(env.CWM_MEASUREMENT_SHA).trim().toLowerCase() : '';
  if (!/^[0-9a-f]{7,40}$/.test(fromMeta)) {
    const err = new Error('app /api/meta did not attest a gitSha');
    err.code = 'MEASUREMENT_SHA_MISSING';
    throw err;
  }
  if (fromEnv && fromEnv !== fromMeta) {
    const err = new Error(`CWM_MEASUREMENT_SHA ${fromEnv} disagrees with app /api/meta gitSha ${fromMeta}`);
    err.code = 'MEASUREMENT_SHA_MISMATCH';
    throw err;
  }
  return fromMeta;
}

function assembleRunDocument({ spec, outputs, identity, sha, steady, appCpu, generatorCpu, sqlCpu, connections, cost, window, backendHealth }) {
  const fields = gcpFields(outputs);
  const topology = outputs.topology || {};
  const vu = vuBudget(spec.rps);
  const declaredCap = Number(topology.mysql_max_connections);
  let saturation = 'unknown';
  if (connections.max == null || !Number.isFinite(declaredCap)) saturation = 'unknown';
  else if (connections.max >= declaredCap) saturation = 'at_cap';
  else saturation = 'below_cap';
  const classes = steady.errorClasses || {};
  const errorCategories = {
    db_timeout: classes.db_timeout == null ? null : classes.db_timeout,
    too_many_connections: classes.too_many_connections == null ? null : classes.too_many_connections,
    queue_full: classes.queue_full == null ? null : classes.queue_full,
    cpu_overload: classes.cpu_overload == null ? null : classes.cpu_overload,
    internal: classes.internal == null ? null : classes.internal,
    iops_throttle: null,
    unclassified: classes.unclassified == null ? null : classes.unclassified,
  };
  const perNode = [];
  for (const [instanceId, cpuAvgPct] of appCpu.entries()) {
    perNode.push({ instanceId, role: 'app', cpuAvgPct, rps: null });
  }
  if (generatorCpu != null) {
    perNode.push({
      instanceId: outputs.generatorInstanceId || fields.generatorName || 'generator',
      role: 'generator',
      cpuAvgPct: generatorCpu,
      rps: steady.steadyThroughputRps == null ? null : steady.steadyThroughputRps,
    });
  }
  perNode.push({
    instanceId: fields.sqlName || outputs.rdsIdentifier || 'cloudsql',
    role: 'database',
    cpuAvgPct: sqlCpu,
    rps: null,
  });
  return {
    isExample: false,
    campaign_id: identity.campaignId,
    run_id: identity.runId,
    split: spec.split,
    diagnostic: 'none',
    scenario: spec.key,
    notes: (spec.split === 'holdout'
      ? 'gcp-holdout-v1 holdout rung. Not fit data; never pool with gcp-fit-v1. '
      : 'gcp-fit-v1 calibration rung. Not a holdout. ') +
      'Latency is steady-only nearest-rank from raw k6 samples. categories is the typical tag count, products is the article count, ordersAtSeed is 0 because seed-typical has no orders table. runtime.version is the Node 20 major pin. iops_throttle is null because Cloud SQL PD_SSD has no BurstBalance.',
    gitSha: sha,
    terraform: {
      applySha: sha,
      amiIds: {
        app: fields.image || 'unmeasured',
        generator: fields.image || 'unmeasured',
      },
      region: GCP_FIT_REGION,
    },
    topology: {
      region: GCP_FIT_REGION,
      alb: { type: 'application' },
      app: {
        instanceType: topology.app_instance_type || 'n2-standard-2',
        count: Number(topology.app_count || spec.expectedAppCount),
        rootVolumeType: 'pd-balanced',
        rootVolumeGiB: 30,
      },
      database: {
        instanceClass: topology.db_instance_class || 'db-custom-2-13312',
        engine: 'mysql',
        engineVersion: '8.0',
        multiAz: false,
        storageType: 'PD_SSD',
        allocatedStorageGiB: 100,
      },
      generator: { instanceType: topology.generator_instance_type || 'c2-standard-4' },
    },
    os: { name: 'pinned-image', amiId: fields.image || 'unmeasured' },
    runtime: { language: 'nodejs', version: '20' },
    application: {
      name: 'cwm-bench-app',
      poolSize: Number(topology.app_pool_size || spec.expectedPoolSize),
      queueLimit: 50,
      profile: 'typical',
      workers: Number(topology.app_workers || spec.expectedWorkers),
    },
    database: {
      engine: 'mysql-8.0',
      maxConnectionsDeclared: Number.isFinite(declaredCap) ? declaredCap : 500,
    },
    dataset: { name: 'seed-typical', categories: 50, products: 10000, ordersAtSeed: 0 },
    requestMix: {
      'GET /api/articles': 59,
      'GET /api/articles/:slug': 20,
      'GET /api/profiles/:username': 10,
      'POST /api/articles/:slug/comments': 10,
      'POST /api/users/login': 1,
    },
    concurrency: {
      targetRps: spec.rps,
      executor: 'k6-arrival-rate',
      preAllocatedVUs: vu.preAllocatedVUs,
      maxVUs: vu.maxVUs,
    },
    warmup: spec.warmup,
    duration: spec.duration,
    repetitions: {
      count: 1,
      varianceNotes: `${spec.split === 'holdout' ? 'gcp-holdout-v1' : 'gcp-fit-v1'} plans 2 reps on separate applies. This document is one rep.`,
    },
    perNode,
    latency: {
      p50Ms: steady.steadyP50Ms,
      p95Ms: steady.steadyP95Ms,
      p99Ms: steady.steadyP99Ms,
      source: 'k6',
    },
    goodputRps: steady.steadyGoodputRps == null ? null : steady.steadyGoodputRps,
    errorCategories,
    databaseConnections: {
      avg: connections.avg,
      max: connections.max,
      saturation,
    },
    burstBalanceMin: { rds: null, appVolumes: [] },
    cost,
    timestamp: window.start,
    ...(backendHealth ? { backendHealth } : {}),
  };
}

function redactDocument(doc) {
  let text;
  try {
    text = redact(JSON.stringify(doc));
    return JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`gcp collect document failed redaction: ${redact(err.message)}`);
    wrapped.code = 'GCP_REDACT_FAILED';
    throw wrapped;
  }
}

export async function collectGcpScenario(ctx, spec) {
  assertNotAliased(spec);
  const identity = requireRunIdentity(ctx.env, spec.key);
  const outputs = await readTerraformOutputs(ctx.deps);
  assertGcpFitIdentity(spec, ctx.env, outputs);
  assertExpectedAppCount(spec, outputs);
  if (spec.expectedPoolSize != null) {
    assertExpectedPool(spec, Number(outputs.topology && outputs.topology.app_pool_size));
  }
  const state = await loadState(ctx.statePath, ctx.deps.fs || {});
  const ladderPlan = resolveLadder(spec, ctx.env);
  const history = ladderHistory(state, identity.campaignId);
  // run has already advanced the ladder. Collect must attest that completed
  // run, not ask whether it would be permitted to execute again.
  const matches = history.filter((row) => row.runId === identity.runId);
  if (matches.length !== 1 || matches[0].scenario !== spec.key || matches[0].rps !== spec.rps) {
    const err = new Error(
      `scenario ${spec.key} requires one completed matching run for CWM_RUN_ID ${identity.runId} in this campaign`,
    );
    err.code = 'GCP_COLLECT_RUN_MISSING';
    throw err;
  }
  // Validate the entire recorded prefix, including a finished three-rung
  // ladder, without modifying state or permitting any new load.
  for (let index = 0; index < history.length; index += 1) {
    const row = history[index];
    assertLadderPosition({ key: row.scenario, rps: row.rps }, ladderPlan, history.slice(0, index));
  }
  const window = requireWindow(ctx.env);
  const runGcloud = requireGcloud(ctx);
  const fields = gcpFields(outputs);
  if (!fields.project) {
    const err = new Error('terraform output project_id is missing');
    err.code = 'GCP_PROJECT_MISSING';
    throw err;
  }

  const metaInvocation = await runRemoteShell(runGcloud, {
    name: fields.generatorName,
    zone: fields.zone,
    project: fields.project,
    command: metaCommand(),
  });
  const meta = await appMeta(metaInvocation.stdout);
  assertExpectedProfile(spec, meta);
  assertExpectedPool(spec, meta && meta.poolSize);
  const sha = attestedSha(meta, ctx.env);

  const steadyInvocation = await runRemoteShell(runGcloud, {
    name: fields.generatorName,
    zone: fields.zone,
    project: fields.project,
    command: steadyCommand(identity.campaignId, identity.runId),
  });
  const steady = parseSteady(steadyInvocation.stdout);
  if (!steady || !steady.present || steady.steadyP50Ms == null || steady.steadyP95Ms == null || steady.steadyP99Ms == null) {
    const err = new Error('steady k6 samples did not produce p50/p95/p99');
    err.code = 'GCP_STEADY_MISSING';
    throw err;
  }
  for (const key of ERROR_CLASSES) {
    if (!steady.errorClasses || !Object.prototype.hasOwnProperty.call(steady.errorClasses, key)) {
      const err = new Error(`steady k6 samples did not report error class ${key}`);
      err.code = 'GCP_ERRORS_MISSING';
      throw err;
    }
  }

  const labelId = String(fields.testId || identity.campaignId).toLowerCase().replace(/_/g, '-');
  const [appSeries, genSeries, sqlCpuSeries, sqlConnSeries] = await Promise.all([
    monitoringQuery(runGcloud, fields.project, vmCpuFilter('app', labelId), window),
    monitoringQuery(runGcloud, fields.project, vmCpuFilter('generator', labelId), window),
    monitoringQuery(runGcloud, fields.project, sqlMetricFilter('cpu/utilization', fields.sqlName), window),
    monitoringQuery(runGcloud, fields.project, sqlMetricFilter('network/connections', fields.sqlName), window),
  ]);
  const appCpu = averageRatioPercent(appSeries);
  const generatorMap = averageRatioPercent(genSeries);
  const sqlMap = averageRatioPercent(sqlCpuSeries);
  const generatorCpu = generatorMap.size ? [...generatorMap.values()][0] : null;
  const sqlCpu = sqlMap.size ? [...sqlMap.values()][0] : null;
  const connections = connectionStats(sqlConnSeries);

  const now = (ctx.now || (() => new Date()))();
  let cost = { source: 'unmeasured', currency: 'USD', hourlyUsd: null, timestamp: now.toISOString() };
  const table = ctx.env.CWM_GCP_BILLING_EXPORT_TABLE;
  if (table) {
    const sql = billingSql(table, fields.project, window.start, window.end);
    const rows = await gcloudJson(runGcloud, [
      'bigquery', 'query',
      '--use_legacy_sql=false',
      '--format=json',
      `--project=${fields.project}`,
      sql,
    ]);
    const raw = Array.isArray(rows) && rows[0] ? rows[0].net_cost : null;
    const net = raw == null || raw === '' ? null : Number(raw);
    const hours = (window.endMs - window.startMs) / 3600000;
    if (Number.isFinite(net) && hours > 0) {
      cost = {
        source: 'bigquery_billing_export',
        currency: 'USD',
        hourlyUsd: net / hours,
        timestamp: now.toISOString(),
      };
    }
  }

  const backendHealth = state.backendHealthByRun && state.backendHealthByRun[identity.runId]
    ? state.backendHealthByRun[identity.runId]
    : null;

  return redactDocument(assembleRunDocument({
    spec,
    outputs,
    identity,
    sha,
    steady,
    appCpu,
    generatorCpu,
    sqlCpu,
    connections,
    cost,
    window,
    backendHealth,
  }));
}

function backendServiceName(outputs) {
  const name = outputs && Array.isArray(outputs.appInstanceIds) ? outputs.appInstanceIds[0] : null;
  if (!name) {
    const err = new Error('GCP backend health gate needs the MIG name from app_instance_ids');
    err.code = 'GCP_BACKEND_SERVICE_MISSING';
    throw err;
  }
  return String(name);
}

async function recordBackendHealth(ctx, runId, evidence) {
  await updateAdapterState(ctx.statePath, (next) => {
    next.backendHealthByRun = next.backendHealthByRun && typeof next.backendHealthByRun === 'object'
      ? next.backendHealthByRun
      : {};
    next.backendHealthByRun[runId] = evidence;
  }, ctx.deps.fs || {});
}

async function awaitGcpBackendHealth(ctx, { fields, outputs, spec, identity }) {
  const backendService = backendServiceName(outputs);
  const expectedCount = Number(
    (outputs.topology && outputs.topology.app_count) || spec.expectedAppCount,
  );
  if (!Number.isFinite(expectedCount) || expectedCount < 1) {
    const err = new Error('GCP backend health gate needs topology.app_count');
    err.code = 'GCP_BACKEND_SERVICE_MISSING';
    throw err;
  }
  const runGcloud = requireGcloud(ctx);
  try {
    const evidence = await waitForBackendHealth({
      probe: async () => {
        try {
          const payload = await gcloudJson(runGcloud, [
            'compute', 'backend-services', 'get-health', backendService,
            '--global',
            `--project=${fields.project}`,
            '--format=json',
          ], { wait: ctx.deps.wait });
          return backendsFromHealthResponse(payload);
        } catch (err) {
          return {
            backends: [],
            error: {
              code: err && err.code ? err.code : 'GCP_CLI_FAILED',
              message: redact(err && err.message ? err.message : String(err)),
            },
          };
        }
      },
      nowMs: ctx.deps.nowMs || Date.now,
      wait: ctx.deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      wallMs: () => (ctx.now || (() => new Date()))().getTime(),
      sustainedMs: Number(ctx.deps.backendHealthSustainedMs || GCP_BACKEND_HEALTH_SUSTAINED_MS),
      timeoutMs: Number(ctx.deps.backendHealthTimeoutMs || GCP_BACKEND_HEALTH_TIMEOUT_MS),
      pollMs: Number(ctx.deps.backendHealthPollMs || GCP_BACKEND_HEALTH_POLL_MS),
      expectedCount,
      backendService,
    });
    await recordBackendHealth(ctx, identity.runId, evidence);
    return evidence;
  } catch (err) {
    if (err && err.backendHealth) {
      await recordBackendHealth(ctx, identity.runId, err.backendHealth);
    }
    throw err;
  }
}

async function prepareGcp(ctx, spec) {
  assertNotAliased(spec);
  const identity = requireRunIdentity(ctx.env, spec.key);
  const outputs = await readTerraformOutputs(ctx.deps);
  const campaignId = assertGcpFitIdentity(spec, ctx.env, outputs);
  assertExpectedAppCount(spec, outputs);
  if (spec.expectedPoolSize != null) {
    assertExpectedPool(spec, Number(outputs.topology && outputs.topology.app_pool_size));
  }
  const state = await loadState(ctx.statePath, ctx.deps.fs || {});
  const ladderPlan = resolveLadder(spec, ctx.env);
  const ladderMeta = assertLadderPosition(spec, ladderPlan, ladderHistory(state, campaignId));
  const timing = assertTiming(spec, ctx.env);
  requireGcloud(ctx);
  const fields = gcpFields(outputs);
  const backendHealth = await awaitGcpBackendHealth(ctx, { fields, outputs, spec, identity });
  const metaInvocation = await runRemoteShell(ctx.deps.runGcloud, {
    name: fields.generatorName,
    zone: fields.zone,
    project: fields.project,
    command: metaCommand(),
  });
  const meta = await appMeta(metaInvocation.stdout);
  assertExpectedProfile(spec, meta);
  assertExpectedPool(spec, meta && meta.poolSize);
  return { identity, outputs, fields, ladderPlan, ladderMeta, timing, meta, backendHealth };
}

export async function runGcpScenario(ctx, spec) {
  const prepared = await prepareGcp(ctx, spec);
  const { identity, fields, ladderPlan, ladderMeta, timing, backendHealth } = prepared;
  const runId = identity.runId;
  await runRemoteShell(ctx.deps.runGcloud, {
    name: fields.generatorName,
    zone: fields.zone,
    project: fields.project,
    command: buildK6Command(spec, {
      campaignId: identity.campaignId,
      runId,
      warmup: timing.warmup,
      duration: timing.duration,
    }),
  });

  // The frozen workload is 20 minutes. Its completion marker is written only
  // after raw-output gzip finishes; allow a bounded five minutes for finalization.
  const deadline = (ctx.deps.nowMs || Date.now)() + Number(ctx.deps.k6WaitMs || 25 * 60 * 1000);
  let exitCode = null;
  for (;;) {
    const status = await runRemoteShell(ctx.deps.runGcloud, {
      name: fields.generatorName,
      zone: fields.zone,
      project: fields.project,
      command: statusCommand(identity.campaignId, runId),
    });
    const match = String(status.stdout).match(/ADAPTER_K6_COMPLETE exit=(\d+)/);
    if (match) {
      exitCode = Number(match[1]);
      break;
    }
    if ((ctx.deps.nowMs || Date.now)() >= deadline) {
      const err = new Error('k6 did not finish before the wait deadline');
      err.code = 'GCP_RUN_TIMEOUT';
      throw err;
    }
    await sleep(ctx.deps.k6PollMs || 30_000, ctx.deps.wait);
  }

  const ok = exitCode === 0;
  if (ok) {
    const now = (ctx.now || (() => new Date()))();
    await updateAdapterState(ctx.statePath, (next) => {
      next.lastRun = { scenario: spec.key, runId, campaignId: identity.campaignId, at: now.toISOString() };
      next.lastRuns = next.lastRuns && typeof next.lastRuns === 'object' ? next.lastRuns : {};
      next.lastRuns[spec.key] = next.lastRun;
      if (ladderPlan.ladder) {
        next.ladderByCampaign = next.ladderByCampaign && typeof next.ladderByCampaign === 'object'
          ? next.ladderByCampaign
          : {};
        const rows = Array.isArray(next.ladderByCampaign[identity.campaignId])
          ? next.ladderByCampaign[identity.campaignId]
          : [];
        rows.push({
          scenario: spec.key,
          rps: spec.rps,
          runId,
          at: now.toISOString(),
          rung_pos: ladderMeta.rung_pos,
        });
        next.ladderByCampaign[identity.campaignId] = rows;
      }
    }, ctx.deps.fs || {});
  }

  return {
    ok,
    adapterVersion: ADAPTER_VERSION,
    scenario: spec.key,
    cloud: 'gcp',
    runId,
    campaignId: identity.campaignId,
    rung_pos: ladderMeta.rung_pos,
    ladder: ladderPlan.ladder,
    exitCode,
    backendHealth,
    ...(ok ? {} : { error: { code: 'K6_FAILED', message: `k6 exit ${exitCode}` } }),
  };
}

export async function waitReadyGcp(ctx, payload, outputs) {
  payload.provisioned = true;
  payload.ready.terraformOutputs = true;
  payload.cloud = 'gcp';
  const region = outputs.region || (outputs.topology && outputs.topology.region);
  if (region !== GCP_FIT_REGION || !outputs.topology || outputs.topology.cloud !== 'gcp') {
    payload.ok = false;
    payload.ready.appHealth = false;
    payload.error = {
      code: 'GCP_REGION_CONSTRAINT',
      message: `gcp stack must be topology.cloud=gcp in ${GCP_FIT_REGION}`,
    };
    return payload;
  }
  const fields = gcpFields(outputs);
  if (typeof ctx.deps.runGcloud !== 'function' || !fields.generatorName) {
    payload.ready.note = 'GCP terraform outputs are present. gcloud ssh was not run.';
    return payload;
  }
  const invocation = await runRemoteShell(ctx.deps.runGcloud, {
    name: fields.generatorName,
    zone: fields.zone,
    project: fields.project,
    command: metaCommand(),
  });
  const meta = await appMeta(invocation.stdout);
  payload.ready.appHealth = Boolean(meta);
  payload.ready.generatorSsm = false;
  payload.ready.generatorSsh = true;
  payload.appNodes = [{
    instanceId: 'lb',
    profile: meta && meta.profile ? meta.profile : null,
    workers: meta && meta.workers != null ? meta.workers : null,
    gitSha: meta && meta.gitSha ? meta.gitSha : null,
  }];
  if (!meta || meta.profile !== 'typical' || Number(meta.workers) !== 2) {
    payload.ok = false;
    payload.error = {
      code: 'PROFILE_MISMATCH',
      message: 'gcp-fit-v1 expects profile typical with 2 workers',
    };
  }
  return payload;
}
