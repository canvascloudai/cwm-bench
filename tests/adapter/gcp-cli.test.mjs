import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGcpCliRunner } from '../../scripts/lib/adapter/gcp-cli.mjs';
import { gcpPreflight } from '../../scripts/gcp-preflight.mjs';
import { billingSql, vmCpuFilter, sqlMetricFilter } from '../../scripts/lib/adapter/gcp.mjs';

const PROJECT = 'example-project';
const START = '2026-11-04T01:00:00.000Z';
const END = '2026-11-04T01:15:00.000Z';
const TOKEN = 'private-test-access-token-fixture';
const FILTER = 'metric.type="compute.googleapis.com/instance/cpu/utilization" AND (resource.labels.instance_id="111")';
const probeVmInventory = async () => ({ code: 0,
  stdout: JSON.stringify({ inventoryOnly: true, roleCounts: { app: 0, generator: 0 } }), stderr: '' });
const args = (filter = FILTER) => [
  'monitoring', 'time-series', 'list', `--project=${PROJECT}`,
  `--filter=${filter}`, `--interval-start-time=${START}`,
  `--interval-end-time=${END}`, '--format=json',
];
const response = (body, status = 200) => ({
  ok: status === 200, status, json: async () => body,
});
const unused = async () => { throw new Error('Unexpected CLI call'); };
function runner(overrides = {}) {
  return createGcpCliRunner({
    runGcloud: unused, runBq: unused,
    getAccessToken: async (project) => { assert.equal(project, PROJECT); return TOKEN; },
    fetchFn: unused, ...overrides,
  });
}

test('Monitoring preserves exact filters/windows and raw points across all pages', async () => {
  const pages = [
    { timeSeries: [{ resource: { labels: { instance_id: '111' } },
      points: [{ value: { doubleValue: 0.25 }, interval: { endTime: END } }] }], nextPageToken: 'next-page' },
    { timeSeries: [{ resource: { labels: { instance_id: '222' } },
      points: [{ value: { int64Value: '30' } }] }] },
  ];
  let i = 0;
  const run = runner({ fetchFn: async (url, options) => {
    assert.equal(url.origin, 'https://monitoring.googleapis.com');
    assert.equal(url.pathname, `/v3/projects/${PROJECT}/timeSeries`);
    assert.equal(url.searchParams.get('filter'), FILTER);
    assert.equal(url.searchParams.get('interval.startTime'), START);
    assert.equal(url.searchParams.get('interval.endTime'), END);
    assert.equal(url.searchParams.get('view'), 'FULL');
    assert.equal(url.searchParams.get('pageToken'), i ? 'next-page' : null);
    assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('aggregation')), false);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return response(pages[i++]);
  } });
  const result = await run(args());
  assert.equal(result.code, 0);
  assert.equal(result.stdout, JSON.stringify(pages.flatMap((page) => page.timeSeries)));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('database CPU and connections filter strings are passed byte-for-byte', async () => {
  for (const metric of ['cpu/utilization', 'network/connections']) {
    const filter = sqlMetricFilter(metric, 'fixture-db');
    const run = runner({ fetchFn: async (url) => {
      assert.equal(url.searchParams.get('filter'), filter);
      return response({});
    } });
    assert.deepEqual(await run(args(filter)), { code: 0, stdout: '[]', stderr: '' });
  }
});

test('Monitoring empty result is an empty list, never synthetic zero-valued points', async () => {
  assert.equal((await runner({ fetchFn: async () => response({}) })(args())).stdout, '[]');
});

test('Monitoring API errors fail closed without response bodies or tokens', async () => {
  const result = await runner({ fetchFn: async () => response({
    error: { status: 'PERMISSION_DENIED', message: `${TOKEN} ${PROJECT}` },
  }, 403) })(args());
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /403 PERMISSION_DENIED/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${TOKEN}|${PROJECT}`));
});

test('authentication and network failures never expose exceptions or credentials', async () => {
  for (const overrides of [
    { getAccessToken: async () => { throw new Error(TOKEN); } },
    { fetchFn: async () => { throw new Error(TOKEN); } },
  ]) {
    const result = await runner(overrides)(args());
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  }
});

test('invalid JSON and malformed series fail rather than silently returning empty data', async () => {
  for (const body of [null, [], { timeSeries: {} }, { nextPageToken: 123 }]) {
    assert.equal((await runner({ fetchFn: async () => response(body) })(args())).code, 1);
  }
  const badJson = { ok: true, json: async () => { throw new Error(TOKEN); } };
  const result = await runner({ fetchFn: async () => badJson })(args());
  assert.equal(result.code, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('a failed later page discards partial metrics and repeated tokens are refused', async () => {
  let n = 0;
  const run = runner({ fetchFn: async () => ++n === 1
    ? response({ timeSeries: [{ points: [] }], nextPageToken: 'next' })
    : response({ error: { status: 'UNAVAILABLE' } }, 503) });
  const result = await run(args());
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const repeated = runner({ fetchFn: async () => response({ nextPageToken: 'repeated' }) });
  assert.match((await repeated(args())).stderr, /repeated a page token/);
});

test('missing, duplicated or unexpected Monitoring flags fail before auth or HTTP', async () => {
  for (const bad of [args().slice(0, -1), [...args(), '--extra=1'],
    args().map((arg) => arg.startsWith('--filter=') ? `--project=${PROJECT}` : arg)]) {
    assert.equal((await runner({ getAccessToken: unused })(bad)).code, 1);
  }
});

test('billing invokes real bq query with byte-identical SQL and unchanged Standard SQL mode', async () => {
  const sql = billingSql('billproj.billing.export_table', PROJECT, START, END);
  const expected = { code: 0, stdout: '[{"net_cost":"2.5"}]', stderr: '' };
  const run = runner({ runBq: async (actual) => {
    assert.deepEqual(actual, [`--project_id=${PROJECT}`, '--format=json',
      'query', '--use_legacy_sql=false', sql]);
    return expected;
  } });
  const result = await run(['bigquery', 'query', '--use_legacy_sql=false',
    '--format=json', `--project=${PROJECT}`, sql]);
  assert.equal(result, expected);
});

test('billing failures and unknown billing flags cannot become successful cost data', async () => {
  const sql = billingSql('billproj.billing.export_table', PROJECT, START, END);
  const input = ['bigquery', 'query', '--use_legacy_sql=false', '--format=json', `--project=${PROJECT}`, sql];
  const failed = { code: 2, stdout: '', stderr: 'BigQuery permission denied' };
  assert.equal(await runner({ runBq: async () => failed })(input), failed);
  assert.equal((await runner()([...input, '--extra=1'])).code, 1);
});

test('SSH, AWS-adjacent and ordinary gcloud routes pass through untouched', async () => {
  const input = ['compute', 'ssh', 'fixture-generator', '--tunnel-through-iap', '--command', 'echo ready'];
  const expected = { code: 0, stdout: 'ready', stderr: '' };
  const run = runner({ runGcloud: async (actual) => { assert.equal(actual, input); return expected; } });
  assert.equal(await run(input), expected);
});

test('production default deps route real child-process calls through bq and Monitoring REST', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gcp-cli-production-'));
  writeFileSync(path.join(dir, 'gcloud'), `#!${process.execPath}\nif(process.argv[2]==='auth'){console.log('${TOKEN}')}else{process.exit(9)}\n`, { mode: 0o700 });
  writeFileSync(path.join(dir, 'bq'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 });
  const execUrl = new URL('../../scripts/lib/adapter/exec.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import {createDefaultDeps} from ${JSON.stringify(execUrl)};
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer ${TOKEN}');
      return {ok:true,json:async()=>({timeSeries:[{points:[{value:{doubleValue:0.25}}]}]})};
    };
    const deps=createDefaultDeps(${JSON.stringify(dir)},{});
    const sql='SELECT 1';
    const bq=await deps.runGcloud(['bigquery','query','--use_legacy_sql=false','--format=json','--project=${PROJECT}',sql]);
    assert.deepEqual(JSON.parse(bq.stdout),['--project_id=${PROJECT}','--format=json','query','--use_legacy_sql=false',sql]);
    const metrics=await deps.runGcloud(${JSON.stringify(args())});
    assert.equal(metrics.code,0);
    assert.equal(JSON.parse(metrics.stdout)[0].points[0].value.doubleValue,0.25);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
  });
});

test('preflight exercises actual production command shapes without load or billed queries', async () => {
  const calls = [];
  const report = await gcpPreflight({
    probeVmInventory,
    env: { GOOGLE_CLOUD_PROJECT: PROJECT },
    now: () => new Date(END),
    runGcloud: async (input) => {
      calls.push(input);
      return { code: 0, stdout: input[0] === 'monitoring' ? '[]' : '{}', stderr: '' };
    },
    runBq: async (input) => {
      assert.deepEqual(input, [`--project_id=${PROJECT}`, '--format=json',
        'query', '--use_legacy_sql=false', '--dry_run', 'SELECT 1']);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.billedQueryExecuted, false);
  assert.equal(calls[1].find((arg) => arg.startsWith('--filter=')),
    '--filter=metric.type="compute.googleapis.com/instance/cpu/utilization"');
  assert.equal(report.measurementCollectionValidated, false);
  assert.ok(calls[1].includes('--interval-start-time=2026-11-04T01:10:00.000Z'));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(PROJECT));
});

test('preflight rejects unavailable commands/APIs and malformed Monitoring JSON', async () => {
  for (const stdout of ['not JSON', '{}']) {
    const report = await gcpPreflight({
      probeVmInventory,
      env: { GOOGLE_CLOUD_PROJECT: PROJECT },
      runGcloud: async () => ({ code: 0, stdout }),
      runBq: async () => ({ code: 2, stdout: '' }),
    });
    assert.equal(report.ok, false);
  }
  const missing = await gcpPreflight({ env: {}, runGcloud: unused, runBq: unused });
  assert.equal(missing.ok, false);
});

test('preflight blocks Monitoring API rejection with all other checks passing', async () => {
  const transport = runner({
    runGcloud: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    fetchFn: async (url) => {
      assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('aggregation')), false);
      assert.equal(url.searchParams.get('filter'), 'metric.type="compute.googleapis.com/instance/cpu/utilization"');
      return response({ error: { status: 'INVALID_ARGUMENT',
        message: 'Resource metadata filters are only allowed on aligned metrics.' } }, 400);
    },
  });
  const report = await gcpPreflight({
    probeVmInventory,
    env: { GOOGLE_CLOUD_PROJECT: PROJECT }, runGcloud: transport,
    runBq: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(report.checks.find((check) => check.name === 'bq-standard-sql-api-dry-run').ok, true);
  assert.equal(report.checks.find((check) => check.name === 'compute-instance-label-inventory-api').ok, true);
  assert.equal(report.checks.find((check) => check.name === 'monitoring-timeSeries.list-api').ok, false);
  assert.equal(report.ok, false);
});
