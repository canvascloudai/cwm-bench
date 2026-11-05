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

function gcpOutputs() {
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
        test_id: CAMPAIGN,
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

function gcloudMock() {
  const calls = [];
  async function runGcloud(args) {
    calls.push(args);
    const command = args.includes('--command') ? args[args.indexOf('--command') + 1] : '';
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
  assert.equal(ADAPTER_VERSION, '1.7.2');
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
    statePath: path.join(mkdtempSync(path.join(tmpdir(), 'gcp-selector-golden-')), 'state.json'),
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
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gcp-collect-')), 'state.json');
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
  for (const key of ['gcp-fit-200', 'gcp-fit-400', 'gcp-fit-600']) {
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
