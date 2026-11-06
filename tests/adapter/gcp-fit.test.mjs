import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { createGcpCliRunner } from '../../scripts/lib/adapter/gcp-cli.mjs';
import { redact } from '../../scripts/lib/adapter/redact.mjs';
import { getScenario } from '../../scripts/lib/adapter/scenarios.mjs';
import { ADAPTER_VERSION, TYPICAL_REGION } from '../../scripts/lib/adapter/version.mjs';
import {
  assertGcpFitIdentity,
  GCP_BACKEND_HEALTH_SUSTAINED_MS,
  GCP_FIT_SPEND_CAP_USD,
  replacementDecision,
  spendCapDecision,
  vmCpuFilter,
} from '../../scripts/lib/adapter/gcp.mjs';
import { MemoryStream } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = '881e0cffd51da084be4a24ffd13366dfbb67063f';
const PROJECT = 'example-project';
const CAMPAIGN = 'gcp-fit-v1-r1-20261104';

function gcpOutputs(campaign = CAMPAIGN) {
  return JSON.stringify({
    project_id: { value: PROJECT, sensitive: true },
    alb_dns: { value: '203.0.113.20' },
    generator_instance_id: { value: '9001' },
    generator_name: { value: 'cwm-bench-gen' },
    generator_zone: { value: 'us-central1-a' },
    app_instance_ids: { value: ['cwm-bench-app'] },
    resolved_ami_id: { value: `projects/${PROJECT}/global/images/pinned`, sensitive: true },
    ami_source: { value: 'variable' },
    rds_identifier: { value: 'cwm-bench-sql' },
    sql_instance_name: { value: 'cwm-bench-sql' },
    rds_endpoint: { value: '10.42.0.3' },
    topology_declaration: {
      value: {
        cloud: 'gcp',
        region: 'us-central1',
        zone: 'us-central1-a',
        alb: 'application',
        app_count: 2,
        app_instance_type: 'n2-standard-2',
        app_pool_size: 250,
        app_profile: 'typical',
        app_workers: 2,
        db_instance_class: 'db-custom-2-13312',
        db_engine: 'mysql',
        db_engine_version: '8.0',
        mysql_max_connections: 500,
        generator_instance_type: 'c2-standard-4',
        test_id: campaign,
      },
    },
  });
}

function steadyStdout() {
  const body = {
    present: true,
    n: 100,
    steadyP50Ms: 11,
    steadyP95Ms: 22,
    steadyP99Ms: 33,
    steadyThroughputRps: 190,
    steadyGoodputRps: 180.5,
    errorClasses: {
      db_timeout: 1,
      too_many_connections: 0,
      queue_full: 2,
      cpu_overload: 0,
      internal: 0,
      unclassified: 3,
    },
  };
  return `---STEADY_JSON---\n${JSON.stringify(body)}\n---END_STEADY_JSON---\n`;
}

function series(instanceId, values, extraLabels = {}) {
  return {
    resource: { labels: { instance_id: instanceId, ...extraLabels } },
    points: values.map((doubleValue) => ({ value: { doubleValue } })),
  };
}

function healthyBackends(project = PROJECT) {
  return [{
    backend: `https://www.googleapis.com/compute/v1/projects/${project}/regions/us-central1/instanceGroups/cwm-bench-app`,
    status: {
      healthStatus: [
        {
          instance: `https://www.googleapis.com/compute/v1/projects/${project}/zones/us-central1-b/instances/cwm-bench-app-one`,
          healthState: 'HEALTHY',
        },
        {
          instance: `https://www.googleapis.com/compute/v1/projects/${project}/zones/us-central1-f/instances/cwm-bench-app-two`,
          healthState: 'HEALTHY',
        },
      ],
    },
  }];
}

function oneHealthyBackend(project = PROJECT) {
  return [{
    backend: `https://www.googleapis.com/compute/v1/projects/${project}/regions/us-central1/instanceGroups/cwm-bench-app`,
    status: {
      healthStatus: [
        {
          instance: `https://www.googleapis.com/compute/v1/projects/${project}/zones/us-central1-b/instances/cwm-bench-app-one`,
          healthState: 'HEALTHY',
        },
      ],
    },
  }];
}

function gcloudMock(options = {}) {
  const calls = [];
  async function runGcloud(args) {
    calls.push(args);
    const command = args.includes('--command') ? args[args.indexOf('--command') + 1] : '';
    if (args[0] === 'compute' && args[1] === 'backend-services' && args[2] === 'get-health') {
      const payload = typeof options.backendHealth === 'function'
        ? options.backendHealth()
        : healthyBackends();
      return { code: 0, stdout: JSON.stringify(payload), stderr: '' };
    }
    if (args[0] === 'compute' && args[1] === 'ssh') {
      if (command.includes('/api/meta')) {
        return {
          code: 0,
          stdout: `{"ok":true}\n{"profile":"typical","workers":2,"poolSize":250,"gitSha":"${SHA}"}\n`,
          stderr: '',
        };
      }
      if (command.includes('cwm-steady-p95.py')) {
        return { code: 0, stdout: steadyStdout(), stderr: '' };
      }
      if (command.includes('ADAPTER_K6_START')) {
        return { code: 0, stdout: 'ADAPTER_K6_STARTED pid=9\n', stderr: '' };
      }
      if (command.includes('ADAPTER_K6_STATUS')) {
        return { code: 0, stdout: 'ADAPTER_K6_COMPLETE exit=0\n', stderr: '' };
      }
    }
    if (args[0] === 'monitoring') {
      const filter = args.find((item) => item.startsWith('--filter=')) || '';
      if (filter.includes('role="app"')) {
        return { code: 0, stdout: JSON.stringify([series('111', [0.25]), series('222', [0.5])]), stderr: '' };
      }
      if (filter.includes('role="generator"')) {
        return { code: 0, stdout: JSON.stringify([series('9001', [0.1])]), stderr: '' };
      }
      if (filter.includes('cpu/utilization')) {
        return { code: 0, stdout: JSON.stringify([series('sql', [0.4])]), stderr: '' };
      }
      if (filter.includes('network/connections')) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            resource: { labels: { database_id: `${PROJECT}:cwm-bench-sql` } },
            points: [{ value: { doubleValue: 10 } }, { value: { doubleValue: 30 } }],
          }]),
          stderr: '',
        };
      }
    }
    if (args[0] === 'bigquery') {
      return { code: 0, stdout: JSON.stringify([{ net_cost: '2.5' }]), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected gcloud ${args[0]}` };
  }
  return { runGcloud, calls };
}

function env(extra = {}) {
  return {
    CWM_CAMPAIGN_ID: CAMPAIGN,
    CWM_RUN_ID: 'gcp-fit-200-r1',
    CWM_SCENARIO: 'gcp-fit-200',
    CWM_MEASUREMENT_SHA: SHA,
    CWM_RUN_STARTED_AT: '2026-11-04T01:00:00.000Z',
    CWM_RUN_ENDED_AT: '2026-11-04T01:15:00.000Z',
    CWM_GCP_BILLING_EXPORT_TABLE: 'billproj.billing.export_table',
    ...extra,
  };
}

function completedStatePath(prefix) {
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), prefix)), 'state.json');
  writeFileSync(statePath, JSON.stringify({
    ladderByCampaign: {
      [CAMPAIGN]: [{ scenario: 'gcp-fit-200', rps: 200, runId: 'gcp-fit-200-r1', rung_pos: 1 }],
    },
  }));
  return statePath;
}

function fakeClock() {
  let elapsedMs = 0;
  return {
    nowMs: () => elapsedMs,
    wait: async (ms) => { elapsedMs += ms; },
  };
}

async function runAdapter(args, options) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(args, { stdout, stderr, ...options });
  let payload;
  try {
    payload = JSON.parse(stdout.toString());
  } catch {
    payload = { raw: stdout.toString() };
  }
  return { code, payload, stdout: stdout.toString(), stderr: stderr.toString() };
}

test('AWS typical keys stay on us-east-2 and the adapter version is unchanged', () => {
  assert.equal(ADAPTER_VERSION, '1.7.4');
  const aws = getScenario('typical-fit-200');
  assert.equal(aws.requiredRegion, TYPICAL_REGION);
  assert.equal(aws.cloud, undefined);
  assert.equal(aws.rps, 200);
  const gcp = getScenario('gcp-fit-200');
  assert.equal(gcp.cloud, 'gcp');
  assert.equal(gcp.split, 'fit');
  assert.deepEqual(gcp.ladder, [200, 400, 600]);
  assert.equal(gcp.warmup, '300s');
  assert.equal(gcp.duration, '900s');
  assert.equal(getScenario('gcp-fit-600').rps, 600);
});

test('redact strips GCP project ids, project numbers, service accounts, and billing accounts', () => {
  const raw = [
    'projects/example-project/global/images/pinned',
    'projects/123456789012/secrets/db',
    '--project=example-project',
    'project.id = "example-project"',
    'app-bench@example-project.iam.gserviceaccount.com',
    'billingAccounts/0123AB-4567CD-89EF01',
    `cleanup pin ${SHA}`,
  ].join('\n');
  const cleaned = redact(raw);
  assert.doesNotMatch(cleaned, /example-project/);
  assert.doesNotMatch(cleaned, /123456789012/);
  assert.doesNotMatch(cleaned, /iam\.gserviceaccount\.com/);
  assert.doesNotMatch(cleaned, /0123AB-4567CD-89EF01/);
  assert.match(cleaned, /REDACTED_GCP_PROJECT_ID/);
  assert.match(cleaned, /REDACTED_GCP_PROJECT_NUMBER/);
  assert.match(cleaned, /REDACTED_GCP_SERVICE_ACCOUNT/);
  assert.match(cleaned, /REDACTED_GCP_BILLING_ACCOUNT/);
  assert.match(cleaned, new RegExp(SHA));
});

test('spend cap pauses and asks, and only runner faults replace the whole apply', () => {
  assert.equal(GCP_FIT_SPEND_CAP_USD, 60);
  const under = spendCapDecision(59.99);
  assert.equal(under.action, 'continue');
  assert.equal(under.autoStop, false);
  const atCap = spendCapDecision(60);
  assert.equal(atCap.action, 'pause');
  assert.equal(atCap.ask, true);
  assert.equal(atCap.autoStop, false);
  const replaced = replacementDecision({ faultClass: 'runner', replacementsUsed: 2 });
  assert.equal(replaced.replaceApply, true);
  assert.equal(replaced.scope, 'whole-apply');
  assert.equal(replaced.autoStop, false);
  const capped = replacementDecision({ faultClass: 'runner', replacementsUsed: 3 });
  assert.equal(capped.replaceApply, false);
  assert.equal(capped.ask, true);
  assert.equal(capped.autoStop, false);
  const workload = replacementDecision({ faultClass: 'workload', replacementsUsed: 0 });
  assert.equal(workload.replaceApply, false);
  const healthTimeout = replacementDecision({
    errorCode: 'GCP_BACKEND_HEALTH_TIMEOUT',
    replacementsUsed: 0,
  });
  assert.equal(healthTimeout.replaceApply, true);
  assert.equal(healthTimeout.preRung, true);
  assert.match(healthTimeout.reason, /backend health timeout/);
});

test('steady_p95.py reports steady p50/p95/p99, error classes, and throughput', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcp-steady-'));
  const lines = [];
  for (let i = 1; i <= 100; i += 1) {
    const time = `2026-11-04T01:${i <= 50 ? '05' : '06'}:00Z`;
    lines.push(JSON.stringify({
      metric: 'http_req_duration', type: 'Point', data: { time, value: i, tags: { phase: 'steady' } },
    }));
    lines.push(JSON.stringify({
      metric: 'http_req_failed', type: 'Point', data: { time, value: i > 98 ? 1 : 0, tags: { phase: 'steady' } },
    }));
  }
  lines.push(JSON.stringify({
    metric: 'errors_by_class', type: 'Point',
    data: { time: '2026-11-04T01:06:00Z', value: 1, tags: { phase: 'steady', error_class: 'queue_full' } },
  }));
  lines.push(JSON.stringify({
    metric: 'http_req_duration', type: 'Point',
    data: { time: '2026-11-04T01:00:00Z', value: 99999, tags: { phase: 'warmup' } },
  }));
  writeFileSync(path.join(dir, 'k6.json.gz'), gzipSync(`${lines.join('\n')}\n`));
  const out = JSON.parse(execFileSync('python3', [
    path.join(ROOT, 'scripts/lib/adapter/steady_p95.py'), dir,
  ], { encoding: 'utf8' }));
  assert.equal(out.n, 100);
  assert.equal(out.steadyP50Ms, 50);
  assert.equal(out.steadyP95Ms, 95);
  assert.equal(out.steadyP99Ms, 99);
  assert.equal(out.errorClasses.queue_full, 1);
  assert.equal(out.errorClasses.db_timeout, 0);
  assert.ok(out.steadyGoodputRps > 0);
  assert.equal(out.method, 'nearest-rank, phase=steady, all http_req_duration points');
});

test('raw instance selection produces byte-identical collect JSON to original label-selected fixture', async () => {
  const original = gcloudMock();
  const readFixture = async (filter) => JSON.parse((await original.runGcloud([
    'monitoring', 'time-series', 'list', `--filter=${filter}`,
  ])).stdout);
  const cli = createGcpCliRunner({
    getAccessToken: async () => 'private-offline-fixture-token',
    runGcloud: original.runGcloud,
    runBq: async (args) => original.runGcloud([
      'bigquery', 'query', '--use_legacy_sql=false', '--format=json',
      `--project=${PROJECT}`, args.at(-1),
    ]),
    fetchFn: async (url) => {
      let body;
      const filter = url.searchParams.get('filter');
      if (url.hostname === 'compute.googleapis.com') {
        const role = filter.includes('role = "app"') ? 'app' : 'generator';
        const ids = role === 'app' ? ['111', '222'] : ['9001'];
        const zone = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/us-central1-a`;
        body = { items: { 'zones/us-central1-a': { instances: ids.map((id) => ({
          id, name: `vm-${id}`, labels: { role, test_id: CAMPAIGN }, zone,
          selfLink: `${zone}/instances/vm-${id}`, creationTimestamp: '2026-11-01T00:00:00Z',
        })) } } };
      } else if (filter.includes('instance_id=')) {
        assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('aggregation')), false);
        assert.equal(url.searchParams.get('interval.startTime'), env().CWM_RUN_STARTED_AT);
        assert.equal(url.searchParams.get('interval.endTime'), env().CWM_RUN_ENDED_AT);
        const role = filter.includes('"9001"') ? 'generator' : 'app';
        const rows = await readFixture(vmCpuFilter(role, CAMPAIGN));
        body = { timeSeries: rows.map((row) => ({ ...row, resource: {
          ...row.resource, type: 'gce_instance',
          labels: { ...row.resource.labels, project_id: PROJECT },
        } })) };
      } else {
        body = { timeSeries: await readFixture(filter) };
      }
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const collect = (runGcloud) => runAdapter(['collect', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-04T01:20:00.000Z'), env: env(),
    statePath: completedStatePath('gcp-selector-golden-'),
    deps: { runGcloud, runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }) },
  });
  const before = await collect(gcloudMock().runGcloud);
  const after = await collect(cli);
  assert.equal(before.code, 0, before.stdout);
  assert.equal(after.code, 0, after.stdout);
  assert.equal(after.stdout, before.stdout);
});

test('gcp collect prints a run document and hides the project id', async () => {
  const gcloud = gcloudMock();
  const statePath = completedStatePath('gcp-collect-');
  const result = await runAdapter(['collect', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-04T01:20:00.000Z'),
    statePath,
    env: env(),
    deps: {
      runGcloud: gcloud.runGcloud,
      runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  const doc = result.payload;
  assert.equal(doc.isExample, false);
  assert.equal(doc.split, 'fit');
  assert.equal(doc.scenario, 'gcp-fit-200');
  assert.equal(doc.diagnostic, 'none');
  assert.deepEqual(doc.latency, { p50Ms: 11, p95Ms: 22, p99Ms: 33, source: 'k6' });
  assert.equal(doc.goodputRps, 180.5);
  assert.equal(doc.errorCategories.queue_full, 2);
  assert.equal(doc.errorCategories.iops_throttle, null);
  assert.equal(doc.perNode.find((row) => row.instanceId === '111').cpuAvgPct, 25);
  assert.equal(doc.perNode.find((row) => row.instanceId === '222').cpuAvgPct, 50);
  assert.equal(doc.perNode.find((row) => row.role === 'generator').cpuAvgPct, 10);
  assert.equal(doc.perNode.find((row) => row.role === 'database').cpuAvgPct, 40);
  assert.equal(doc.databaseConnections.max, 30);
  assert.equal(doc.databaseConnections.saturation, 'below_cap');
  assert.equal(doc.cost.source, 'bigquery_billing_export');
  assert.equal(doc.cost.hourlyUsd, 10);
  assert.equal(doc.warmup, '300s');
  assert.equal(doc.duration, '900s');
  assert.equal(doc.gitSha, SHA);
  assert.doesNotMatch(result.stdout, new RegExp(PROJECT));
  assert.match(doc.os.amiId, /REDACTED_GCP_PROJECT_ID/);
  assert.equal(doc.ok, undefined);
  const checked = spawnSync('python3', ['-c', `
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(${JSON.stringify(path.join(ROOT, 'schema/run.schema.json'))}))
doc = json.load(sys.stdin)
errors = list(Draft202012Validator(schema).iter_errors(doc))
if errors:
    raise SystemExit('; '.join(f"{e.json_path}: {e.message}" for e in errors))
`], { input: result.stdout, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(vmCpuFilter('app', CAMPAIGN), /role="app"/);
});

test('GCP holdout identity, ladder and workload keys are distinct from fit', () => {
  const outputs = JSON.parse(gcpOutputs());
  const declaration = outputs.topology_declaration.value;
  const normalized = { region: 'us-central1', topology: declaration };
  const holdoutId = 'gcp-holdout-v1-r1-20261104';
  for (const rps of [300, 400, 500]) {
    const spec = getScenario(`gcp-holdout-${rps}`);
    assert.equal(spec.split, 'holdout');
    assert.equal(spec.kind, 'holdout');
    assert.equal(spec.rps, rps);
    assert.deepEqual(spec.ladder, [300, 400, 500]);
    assert.equal(spec.warmup, '300s');
    assert.equal(spec.duration, '900s');
    assert.equal(spec.aliasOf, null);
    assert.throws(() => assertGcpFitIdentity(spec, {}, normalized), { code: 'TEST_ID_MISMATCH' });
    declaration.test_id = holdoutId;
    assert.equal(assertGcpFitIdentity(spec, {}, normalized), holdoutId);
    for (const bad of ['gcp-holdout-v1-r3-20261104', 'gcp-holdout-v1-r1d-20261104']) {
      declaration.test_id = bad;
      assert.throws(() => assertGcpFitIdentity(spec, {}, normalized), { code: 'TEST_ID_MISMATCH' });
    }
    declaration.test_id = CAMPAIGN;
  }
  declaration.test_id = holdoutId;
  assert.throws(() => assertGcpFitIdentity(getScenario('gcp-fit-400'), {}, normalized),
    { code: 'TEST_ID_MISMATCH' });
  for (const key of ['gcp-holdout-200', 'gcp-holdout-600']) {
    assert.throws(() => getScenario(key), { code: 'UNKNOWN_SCENARIO' });
  }
});

test('gcp run enforces 200 then 400 then 600 and does not touch AWS SSM', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcp-run-'));
  const statePath = path.join(dir, 'state.json');
  const deps = () => {
    const gcloud = gcloudMock();
    return {
      gcloud,
      deps: {
        runGcloud: gcloud.runGcloud,
        runAws: async () => { throw new Error('AWS must not be called'); },
        runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
        ...fakeClock(),
        k6PollMs: 1,
        k6WaitMs: 1000,
      },
    };
  };
  const early = deps();
  const rejected = await runAdapter(['run', '--scenario', 'gcp-fit-400', '--json'], {
    now: () => new Date('2026-11-04T01:00:00.000Z'),
    statePath,
    env: env({ CWM_SCENARIO: 'gcp-fit-400', CWM_RUN_ID: 'gcp-fit-400-r1' }),
    deps: early.deps,
  });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.payload.error.code, 'LADDER_ORDER');
  assert.equal(early.gcloud.calls.some((args) => args[0] === 'ssm'), false);

  const first = deps();
  const started = await runAdapter(['run', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-04T01:00:00.000Z'),
    statePath,
    env: env(),
    deps: first.deps,
  });
  assert.equal(started.code, 0, started.stdout);
  assert.equal(started.payload.ok, true);
  assert.equal(started.payload.rung_pos, 1);
  assert.deepEqual(started.payload.ladder, [200, 400, 600]);
  const startCommand = first.gcloud.calls.map((args) => args.join('\n')).find((text) => text.includes('ADAPTER_K6_START'));
  assert.match(startCommand, /WARMUP='300s'/);
  assert.match(startCommand, /DURATION='900s'/);
  assert.match(startCommand, /SCENARIO='gcp-fit-200'/);
  assert.equal(first.gcloud.calls.some((args) => args[0] === 'ssm'), false);
});

for (const campaign of [
  { prefix: 'gcp-fit', ladder: [200, 400, 600], split: 'fit' },
  { prefix: 'gcp-holdout', ladder: [300, 400, 500], split: 'holdout' },
]) {
test(`${campaign.prefix} full ${campaign.ladder.join('/')} run-collect sequence uses persistent state and the real CLI transport offline`, async () => {
  const CAMPAIGN = `${campaign.prefix}-v1-r1-20261104`;
  const key = (rps) => `${campaign.prefix}-${rps}`;
  const [first, second, last] = campaign.ladder;
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-full-ladder-')), 'state.json');
  const mock = gcloudMock();
  let elapsedMs = 0;
  const delayedCompletionPolls = [];
  const restCalls = [];
  const bqCalls = [];
  let activeWindow;
  const rungWindow = (rps) => {
    const start = Date.parse('2026-11-04T01:00:00.000Z') + campaign.ladder.indexOf(rps) * 1200_000 + 300_000;
    return { start: new Date(start).toISOString(), end: new Date(start + 900_000).toISOString() };
  };
  const cli = createGcpCliRunner({
    getAccessToken: async () => 'private-offline-fixture-token',
    runGcloud: async (args) => {
      if (args.some((arg) => String(arg).includes('ADAPTER_K6_STATUS')) && elapsedMs < 1_232_000) {
        delayedCompletionPolls.push(elapsedMs);
        return { code: 0, stdout: 'ADAPTER_K6_RUNNING\n', stderr: '' };
      }
      return mock.runGcloud(args);
    },
    runBq: async (args) => {
      bqCalls.push(args);
      assert.ok(args.at(-1).includes(activeWindow.start));
      assert.ok(args.at(-1).includes(activeWindow.end));
      return mock.runGcloud([
        'bigquery', 'query', '--use_legacy_sql=false', '--format=json',
        `--project=${PROJECT}`, args.at(-1),
      ]);
    },
    fetchFn: async (url) => {
      restCalls.push(String(url));
      const filter = url.searchParams.get('filter');
      let body;
      if (url.hostname === 'compute.googleapis.com') {
        const generator = filter.includes('role = "generator"');
        const ids = generator ? ['9001'] : ['111', '222'];
        const zone = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/us-central1-a`;
        body = { items: { 'zones/us-central1-a': { instances: ids.map((id) => ({
          id, name: `vm-${id}`, labels: { role: generator ? 'generator' : 'app', test_id: CAMPAIGN },
          zone, selfLink: `${zone}/instances/vm-${id}`, creationTimestamp: '2026-11-01T00:00:00Z',
        })) } } };
      } else {
        assert.equal(url.hostname, 'monitoring.googleapis.com');
        assert.equal(url.searchParams.get('interval.startTime'), activeWindow.start);
        assert.equal(url.searchParams.get('interval.endTime'), activeWindow.end);
        assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('aggregation')), false);
        let legacyFilter = filter;
        if (filter.includes('instance_id=')) {
          legacyFilter = vmCpuFilter(filter.includes('"9001"') ? 'generator' : 'app', CAMPAIGN);
        }
        const reply = await mock.runGcloud(['monitoring', 'time-series', 'list', `--filter=${legacyFilter}`]);
        const rows = JSON.parse(reply.stdout);
        body = { timeSeries: filter.includes('instance_id=') ? rows.map((row) => ({
          ...row,
          resource: { ...row.resource, type: 'gce_instance', labels: {
            ...row.resource.labels, project_id: PROJECT,
          } },
        })) : rows };
      }
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const invoke = (command, rps, overrides = {}) => {
    if (command === 'run') elapsedMs = 0;
    activeWindow = rungWindow(rps);
    return runAdapter(
    [command, '--scenario', key(rps), '--json'],
    {
      now: () => new Date(Date.parse(activeWindow.end) + 20_000),
      statePath,
      env: env({
        CWM_CAMPAIGN_ID: CAMPAIGN,
        CWM_SCENARIO: key(rps), CWM_RUN_ID: `${key(rps)}-r1`,
        CWM_RUN_STARTED_AT: activeWindow.start, CWM_RUN_ENDED_AT: activeWindow.end,
        ...overrides,
      }),
      deps: {
        runGcloud: cli,
        runTerraform: async () => ({ code: 0, stdout: gcpOutputs(CAMPAIGN), stderr: '' }),
        runAws: async () => { throw new Error('AWS is forbidden in this offline GCP fixture'); },
        nowMs: () => elapsedMs,
        wait: async (ms) => { elapsedMs += ms; },
      },
    },
  );
  };
  const noRun = await invoke('collect', first);
  assert.equal(noRun.payload.error.code, 'GCP_COLLECT_RUN_MISSING');
  assert.equal(mock.calls.length, 0);
  for (const [index, rps] of campaign.ladder.entries()) {
    const started = await invoke('run', rps);
    assert.equal(started.code, 0, started.stdout);
    assert.equal(started.payload.rung_pos, index + 1);
    assert.ok(elapsedMs >= 1_232_000, 'wait for gzip/completion beyond the unchanged 20-minute workload');
    const beforeCollect = readFileSync(statePath, 'utf8');
    const collected = await invoke('collect', rps);
    assert.equal(collected.code, 0, collected.stdout);
    assert.equal(collected.payload.scenario, key(rps));
    assert.equal(collected.payload.concurrency.targetRps, rps);
    assert.equal(collected.payload.gitSha, SHA);
    assert.equal(collected.payload.split, campaign.split);
    assert.match(collected.payload.notes, campaign.split === 'holdout' ? /Not fit data/ : /Not a holdout/);
    assert.equal(collected.payload.isExample, false);
    assert.deepEqual(collected.payload.latency, { p50Ms: 11, p95Ms: 22, p99Ms: 33, source: 'k6' });
    assert.equal(collected.payload.goodputRps, 180.5);
    assert.equal(collected.payload.databaseConnections.max, 30);
    assert.equal(collected.payload.cost.hourlyUsd, 10);
    assert.equal(readFileSync(statePath, 'utf8'), beforeCollect, 'collect must never advance or rewrite state');
    const replay = await invoke('run', rps);
    assert.equal(replay.payload.error.code, 'LADDER_ORDER', 'collect must not enable a rung retry');
    if (rps === first) {
      const skipped = await invoke('run', last);
      assert.equal(skipped.payload.error.code, 'LADDER_ORDER');
    }
  }
  const completeState = readFileSync(statePath, 'utf8');
  assert.ok(delayedCompletionPolls.includes(1_200_000), 'each rung must tolerate post-workload finalization');
  assert.deepEqual(JSON.parse(completeState).ladderByCampaign[CAMPAIGN].map((row) => row.rps), campaign.ladder);
  for (const rps of campaign.ladder) {
    const collected = await invoke('collect', rps);
    assert.equal(collected.code, 0, collected.stdout);
    assert.equal(readFileSync(statePath, 'utf8'), completeState);
  }
  const wrongRun = await invoke('collect', first, { CWM_RUN_ID: `${key(first)}-wrong-run` });
  assert.equal(wrongRun.payload.error.code, 'GCP_COLLECT_RUN_MISSING');
  const wrongScenario = await invoke('collect', second, { CWM_RUN_ID: `${key(first)}-r1` });
  assert.equal(wrongScenario.payload.error.code, 'GCP_COLLECT_RUN_MISSING');
  const wrongCampaign = await invoke('collect', first, { CWM_CAMPAIGN_ID: `${campaign.prefix}-v1-r2-20261104` });
  assert.equal(wrongCampaign.payload.error.code, 'TEST_ID_MISMATCH');
  const starts = mock.calls.filter((args) => args.some((arg) => String(arg).includes('ADAPTER_K6_START')));
  assert.equal(starts.length, 3);
  for (const [index, args] of starts.entries()) {
    const command = args[args.indexOf('--command') + 1];
    assert.match(command, /WARMUP='300s'/);
    assert.match(command, /DURATION='900s'/);
    assert.ok(command.includes(`SCENARIO='${key(campaign.ladder[index])}'`));
  }
  assert.equal(bqCalls.length, 6);
  assert.ok(bqCalls.every((args) => args.includes('--use_legacy_sql=false')));
  assert.ok(restCalls.some((url) => url.includes('compute.googleapis.com')));
  assert.ok(restCalls.some((url) => url.includes('monitoring.googleapis.com')));
});
}

test('gcp collect rejects corrupt, overlong and ambiguous completed-run history before cloud access', async () => {
  const row = (rps, runId = `gcp-fit-${rps}-r1`) => ({ scenario: `gcp-fit-${rps}`, rps, runId });
  for (const [history, code] of [
    [[row(200), row(600)], 'LADDER_ORDER'],
    [[row(200), row(400), row(600), row(600, 'extra')], 'LADDER_ORDER'],
    [[row(200), row(400, 'gcp-fit-200-r1')], 'GCP_COLLECT_RUN_MISSING'],
    [[{ ...row(200), scenario: 'gcp-fit-400' }], 'GCP_COLLECT_RUN_MISSING'],
  ]) {
    const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-corrupt-ladder-')), 'state.json');
    writeFileSync(statePath, JSON.stringify({ ladderByCampaign: { [CAMPAIGN]: history } }));
    const result = await runAdapter(['collect', '--scenario', 'gcp-fit-200', '--json'], {
      statePath, env: env(),
      deps: {
        runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
        runGcloud: async () => { throw new Error('Cloud must not be contacted'); },
      },
    });
    assert.equal(result.payload.error.code, code, result.stdout);
  }
});

async function completionWaitFixture({ completeAtMs = Infinity, exitCode = 0, waitMs } = {}) {
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-completion-wait-')), 'state.json');
  writeFileSync(statePath, '{}\n');
  const mock = gcloudMock();
  let elapsedMs = 0;
  const result = await runAdapter(['run', '--scenario', 'gcp-fit-200', '--json'], {
    statePath, env: env(),
    deps: {
      runGcloud: async (args) => {
        if (args.some((arg) => String(arg).includes('ADAPTER_K6_STATUS'))) {
          return {
            code: 0,
            stdout: elapsedMs >= completeAtMs
              ? `ADAPTER_K6_COMPLETE exit=${exitCode}\n` : 'ADAPTER_K6_RUNNING\n',
            stderr: '',
          };
        }
        return mock.runGcloud(args);
      },
      runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
      runAws: async () => { throw new Error('AWS is forbidden in this offline fixture'); },
      nowMs: () => elapsedMs,
      wait: async (ms) => { elapsedMs += ms; },
      k6WaitMs: waitMs,
    },
  });
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal((state.ladderByCampaign?.[CAMPAIGN] || []).length, 0,
    'timeouts and failed k6 exits must not advance the ladder');
  assert.equal(state.backendHealthByRun?.[env().CWM_RUN_ID]?.status, 'passed',
    'the health gate records evidence even when k6 later fails');
  return { result, elapsedMs };
}

test('gcp completion wait stays bounded when the marker never arrives', async () => {
  const { result, elapsedMs } = await completionWaitFixture();
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.payload.error.code, 'GCP_RUN_TIMEOUT');
  assert.equal(elapsedMs, GCP_BACKEND_HEALTH_SUSTAINED_MS + 25 * 60 * 1000);
});

test('gcp completion wait preserves an explicit injected deadline', async () => {
  const { result, elapsedMs } = await completionWaitFixture({ waitMs: 60_000 });
  assert.equal(result.payload.error.code, 'GCP_RUN_TIMEOUT');
  assert.equal(elapsedMs, GCP_BACKEND_HEALTH_SUSTAINED_MS + 60_000);
});

test('gcp delayed nonzero k6 exit remains a workload failure, not success', async () => {
  const { result, elapsedMs } = await completionWaitFixture({ completeAtMs: 1_232_000, exitCode: 1 });
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'K6_FAILED');
  assert.ok(elapsedMs >= 1_232_000);
});

test('gcp a failed run cannot be collected as a completed rung', async () => {
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-failed-run-')), 'state.json');
  const mock = gcloudMock();
  const deps = {
    runGcloud: async (args) => args.some((arg) => String(arg).includes('ADAPTER_K6_STATUS'))
      ? { code: 0, stdout: 'ADAPTER_K6_COMPLETE exit=1\n', stderr: '' }
      : mock.runGcloud(args),
    runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
    ...fakeClock(),
    k6PollMs: 1, k6WaitMs: 1000,
  };
  const failed = await runAdapter(['run', '--scenario', 'gcp-fit-200', '--json'], {
    statePath, env: env(), deps,
  });
  assert.equal(failed.payload.ok, false);
  const collected = await runAdapter(['collect', '--scenario', 'gcp-fit-200', '--json'], {
    statePath, env: env(), deps,
  });
  assert.equal(collected.payload.error.code, 'GCP_COLLECT_RUN_MISSING');
});

test('existing GCP scenario keys remain accepted after the backend-health gate', () => {
  for (const key of [
    'gcp-fit-200', 'gcp-fit-400', 'gcp-fit-600',
    'gcp-holdout-300', 'gcp-holdout-400', 'gcp-holdout-500',
  ]) {
    const spec = getScenario(key);
    assert.equal(spec.key, key);
    assert.equal(spec.cloud, 'gcp');
  }
  for (const key of ['gcp-holdout-200', 'gcp-holdout-600', 'gcp-fit-300']) {
    assert.throws(() => getScenario(key), { code: 'UNKNOWN_SCENARIO' });
  }
});

test('gcp run waits for sustained backend health before starting k6 and records evidence', async () => {
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-health-pass-')), 'state.json');
  const mock = gcloudMock();
  let elapsedMs = 0;
  const result = await runAdapter(['run', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-06T14:00:00.000Z'),
    statePath,
    env: env(),
    deps: {
      runGcloud: mock.runGcloud,
      runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
      nowMs: () => elapsedMs,
      wait: async (ms) => { elapsedMs += ms; },
      k6PollMs: 1,
      k6WaitMs: 1000,
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.backendHealth.status, 'passed');
  assert.equal(result.payload.backendHealth.expectedCount, 2);
  assert.equal(result.payload.backendHealth.lastSnapshot.healthyCount, 2);
  assert.doesNotMatch(result.stdout, new RegExp(PROJECT));
  const healthIdx = mock.calls.findIndex((args) => args[1] === 'backend-services' && args[2] === 'get-health');
  const startIdx = mock.calls.findIndex((args) => args.some((arg) => String(arg).includes('ADAPTER_K6_START')));
  assert.ok(healthIdx >= 0);
  assert.ok(startIdx > healthIdx, 'k6 must not start before the backend-health gate passes');
  assert.ok(mock.calls[healthIdx].includes('--global'));
  assert.ok(elapsedMs >= GCP_BACKEND_HEALTH_SUSTAINED_MS);
  const collected = await runAdapter(['collect', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-06T14:20:00.000Z'),
    statePath,
    env: env(),
    deps: {
      runGcloud: mock.runGcloud,
      runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
    },
  });
  assert.equal(collected.code, 0, collected.stdout);
  assert.equal(collected.payload.backendHealth.status, 'passed');
  assert.equal(collected.payload.backendHealth.lastSnapshot.backends.length, 2);
  assert.doesNotMatch(collected.stdout, new RegExp(PROJECT));
  const checked = spawnSync('python3', ['-c', `
import json, sys
from jsonschema import Draft202012Validator
schema = json.load(open(${JSON.stringify(path.join(ROOT, 'schema/run.schema.json'))}))
doc = json.load(sys.stdin)
errors = list(Draft202012Validator(schema).iter_errors(doc))
if errors:
    raise SystemExit('; '.join(f"{e.json_path}: {e.message}" for e in errors))
`], { input: collected.stdout, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

test('gcp run does not start k6 when only one MIG backend is healthy', async () => {
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-health-timeout-')), 'state.json');
  const mock = gcloudMock({ backendHealth: () => oneHealthyBackend() });
  let elapsedMs = 0;
  const result = await runAdapter(['run', '--scenario', 'gcp-fit-200', '--json'], {
    now: () => new Date('2026-11-06T14:00:00.000Z'),
    statePath,
    env: env(),
    deps: {
      runGcloud: mock.runGcloud,
      runTerraform: async () => ({ code: 0, stdout: gcpOutputs(), stderr: '' }),
      nowMs: () => elapsedMs,
      wait: async (ms) => { elapsedMs += ms; },
      backendHealthTimeoutMs: 30_000,
      backendHealthPollMs: 5_000,
    },
  });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.payload.error.code, 'GCP_BACKEND_HEALTH_TIMEOUT');
  assert.equal(result.payload.error.replaceable, true);
  assert.equal(result.payload.error.faultClass, 'runner');
  assert.equal(result.payload.error.preRung, true);
  assert.equal(result.payload.error.backendHealth.status, 'timeout');
  assert.equal(result.payload.error.backendHealth.lastSnapshot.healthyCount, 1);
  assert.doesNotMatch(result.stdout, new RegExp(PROJECT));
  assert.equal(mock.calls.some((args) => args.some((arg) => String(arg).includes('ADAPTER_K6_START'))), false);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal((state.ladderByCampaign?.[CAMPAIGN] || []).length, 0);
  assert.equal(state.backendHealthByRun?.[env().CWM_RUN_ID]?.status, 'timeout');
});

test('gcp userdata follows the typical app and cleanup lists GCP addresses only under gcp', () => {
  const app = readFileSync(path.join(ROOT, 'terraform/gcp/userdata/app.sh.tftpl'), 'utf8');
  const aws = readFileSync(path.join(ROOT, 'terraform/userdata/app.sh.tftpl'), 'utf8');
  assert.match(app, /seed-typical\.sql/);
  assert.match(app, /app-typical/);
  assert.match(app, /APP_PROFILE/);
  assert.match(app, /APP_WORKERS/);
  assert.match(app, /gcloud secrets versions access/);
  assert.doesNotMatch(app, /aws ssm get-parameter/);
  assert.match(aws, /aws ssm get-parameter/);
  assert.doesNotMatch(aws, /gcloud secrets/);

  const spec = JSON.parse(readFileSync(path.join(ROOT, 'scripts/cleanup-compat.json'), 'utf8'));
  assert.equal(spec.pinnedCleanupRevision, 'e95c5319b5c7b9cbd934735241b355df4144cab0');
  assert.ok(spec.resourceAddresses.includes('aws_db_instance.main'));
  assert.equal(spec.gcp.sweep.delayedHours, 24);
  assert.equal(spec.gcp.sweep.immediate, true);
  const tf = readdirSync(path.join(ROOT, 'terraform/gcp'))
    .filter((name) => name.endsWith('.tf'))
    .map((name) => readFileSync(path.join(ROOT, 'terraform/gcp', name), 'utf8'))
    .join('\n');
  for (const address of spec.gcp.resourceAddresses) {
    const [type, name] = address.split('.');
    assert.match(tf, new RegExp(`resource\\s+"${type}"\\s+"${name}"`), address);
  }
  assert.doesNotMatch(tf, /\b[0-9]{12}\b/);
  assert.doesNotMatch(tf, /iam\.gserviceaccount\.com/);
  assert.doesNotMatch(tf, /[0-9A-Fa-f]{6}-[0-9A-Fa-f]{6}-[0-9A-Fa-f]{6}/);
  const sweep = readFileSync(path.join(ROOT, 'scripts/gcp-cleanup-sweep.sh'), 'utf8');
  assert.match(sweep, /24 hours/);
  assert.match(sweep, /not a campaign result/);
  for (const key of ['gcp-fit-200', 'gcp-fit-400', 'gcp-fit-600',
    'gcp-holdout-300', 'gcp-holdout-400', 'gcp-holdout-500']) {
    const inspected = spawnSync('k6', ['inspect', '-e', `SCENARIO=${key}`, path.join(ROOT, 'load/typical.js')], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
  }
  const runbook = readFileSync(path.join(ROOT, 'typical/RUNBOOK-CANVASCLOUDAI.md'), 'utf8');
  assert.match(runbook, /does not use GitHub/);
  assert.match(runbook, /stop for review/i);
  const prereg = readFileSync(path.join(ROOT, 'typical/gcp-fit-v1/PREREGISTRATION.md'), 'utf8');
  assert.match(prereg, /not a holdout/i);
  assert.match(prereg, /\$60/);
});
