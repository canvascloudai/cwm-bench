import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGcpCliRunner, gcpVmInventoryProbe } from '../../scripts/lib/adapter/gcp-cli.mjs';
import { parseVmCpuSelector, listLabeledVms, rawVmCpuFilter } from '../../scripts/lib/adapter/gcp-vm-selector.mjs';
import { vmCpuFilter, sqlMetricFilter } from '../../scripts/lib/adapter/gcp.mjs';

const PROJECT = 'example-project', TEST_ID = 'gcp-fit-v1-r1-20261104';
const TOKEN = 'private-unit-test-token-not-a-credential';
const START = '2026-11-04T01:00:00.000Z', END = '2026-11-04T01:15:00.000Z';
const CPU = 'metric.type="compute.googleapis.com/instance/cpu/utilization"';
function vm(id, role = 'app', overrides = {}) {
  const base = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/us-central1-a`;
  return { id, name: `vm-${id}`, zone: base, selfLink: `${base}/instances/vm-${id}`,
    labels: { role, test_id: TEST_ID }, creationTimestamp: '2026-11-01T00:00:00Z', ...overrides };
}
const page = (instances, extra = {}) => ({ items: { 'zones/us-central1-a': { instances } }, ...extra });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const config = (fetchFn, extra = {}) => ({ project: PROJECT, role: 'app', testId: TEST_ID, token: TOKEN, fetchFn, ...extra });
const args = (role = 'app') => [
  'monitoring', 'time-series', 'list', `--project=${PROJECT}`, `--filter=${vmCpuFilter(role, TEST_ID)}`,
  `--interval-start-time=${START}`, `--interval-end-time=${END}`, '--format=json',
];
function metric(id, values = [0.25, 0.5]) {
  return { metric: { type: 'compute.googleapis.com/instance/cpu/utilization' },
    resource: { type: 'gce_instance', labels: { instance_id: id, project_id: PROJECT, zone: 'us-central1-a' } },
    points: values.map((value) => ({ interval: { startTime: START, endTime: END }, value: { doubleValue: value } })) };
}
function transport(fetchFn) {
  return createGcpCliRunner({ fetchFn, getAccessToken: async () => TOKEN,
    runGcloud: async () => { throw Error('Unexpected CLI'); },
    runBq: async () => { throw Error('Unexpected billing'); } });
}

test('app labels resolve to exact raw instance IDs without rewriting points or windows', async () => {
  const points = [metric('111'), metric('222', [0.625, 0.75])];
  const calls = [];
  const run = transport(async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.hostname === 'compute.googleapis.com') {
      assert.equal(url.searchParams.get('filter'), `labels.role = "app" AND labels.test_id = "${TEST_ID}"`);
      assert.equal(url.searchParams.get('returnPartialSuccess'), 'false');
      const fields = url.searchParams.get('fields');
      assert.match(fields, /instances\(id,name,zone,selfLink,labels,creationTimestamp\)/);
      assert.doesNotMatch(fields, /metadata|networkInterfaces|serviceAccounts|disks/);
      return response(page([vm('222'), vm('111')]));
    }
    assert.equal(url.searchParams.get('filter'), `${CPU} AND (resource.labels.instance_id="111" OR resource.labels.instance_id="222")`);
    assert.equal(url.searchParams.get('interval.startTime'), START);
    assert.equal(url.searchParams.get('interval.endTime'), END);
    assert.equal(url.searchParams.get('view'), 'FULL');
    assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('aggregation')), false);
    return response({ timeSeries: points });
  });
  const result = await run(args());
  assert.equal(result.code, 0);
  assert.equal(result.stdout, JSON.stringify(points));
  assert.equal(calls.length, 2);
});

test('generator selection preserves uint64 IDs above JS safe integer range', async () => {
  const id = '18446744073709551615';
  const run = transport(async (url) => {
    if (url.hostname === 'compute.googleapis.com') {
      assert.match(url.searchParams.get('filter'), /role = "generator"/);
      return response(page([vm(id, 'generator')]));
    }
    assert.match(url.searchParams.get('filter'), new RegExp(`instance_id="${id}"`));
    return response({ timeSeries: [metric(id)] });
  });
  assert.equal((await run(args('generator'))).code, 0);
});

test('inventory paginates before raw selection; Monitoring pagination preserves series order', async () => {
  const output = [metric('111'), metric('222')];
  const run = transport(async (url) => {
    if (url.hostname === 'compute.googleapis.com') return response(url.searchParams.has('pageToken')
      ? page([vm('222')]) : page([vm('111')], { nextPageToken: 'inventory-page-2' }));
    return response(url.searchParams.has('pageToken')
      ? { timeSeries: [output[1]] } : { timeSeries: [output[0]], nextPageToken: 'metrics-page-2' });
  });
  assert.equal((await run(args())).stdout, JSON.stringify(output));
});

test('inventory accepts API zone identifiers with extended suffixes and empty-zone warnings', async () => {
  const zone = 'us-south1-ai1b';
  const base = vm('111');
  const instance = { ...base, zone: base.zone.replace('us-central1-a', zone),
    selfLink: base.selfLink.replace('us-central1-a', zone) };
  const result = await listLabeledVms(config(async () => response({ items: {
    [`zones/${zone}`]: { instances: [instance] },
    'zones/us-central1-a': { warning: { code: 'NO_RESULTS_ON_PAGE' } },
  } })));
  assert.deepEqual(result, [{ id: '111', createdAt: base.creationTimestamp }]);
});

test('empty inventory refuses collection but is allowed only for zero-resource preflight', async () => {
  let monitoring = 0;
  const fetchFn = async (url) => {
    if (url.hostname !== 'compute.googleapis.com') monitoring++;
    return response({});
  };
  const result = await transport(fetchFn)(args());
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(monitoring, 0);
  const probe = await gcpVmInventoryProbe({ project: PROJECT, testId: TEST_ID,
    getAccessToken: async () => TOKEN, fetchFn });
  assert.equal(probe.code, 0);
  assert.deepEqual(JSON.parse(probe.stdout), { inventoryOnly: true, roleCounts: { app: 0, generator: 0 } });
});

test('wrong labels, role, project, zone, self-link or unsafe numeric IDs fail closed', async () => {
  const base = vm('111');
  for (const override of [
    { labels: { role: 'generator', test_id: TEST_ID } },
    { labels: { role: 'app', test_id: 'other-campaign' } },
    { zone: base.zone.replace(PROJECT, 'wrong-project') },
    { selfLink: base.selfLink.replace(PROJECT, 'wrong-project') },
    { zone: base.zone.replace('us-central1-a', 'us-east1-b') },
    { id: 9007199254740993 }, { id: '18446744073709551616' },
    { id: '111" OR true' }, { creationTimestamp: 'not-a-time' },
  ]) {
    await assert.rejects(listLabeledVms(config(async () => response(page([{ ...base, ...override }])))));
  }
});

test('partial, unreachable, malformed and unexpected warning inventories are refused', async () => {
  for (const body of [
    null, [], { items: [] }, page([vm('111')], { unreachables: ['us-east1-b'] }),
    { items: { 'zones/us-central1-a': { warning: { code: 'UNREACHABLE' } } } },
    { items: { 'zones/us-central1-a': { instances: {} } } },
    page([vm('111')], { nextPageToken: 5 }),
  ]) await assert.rejects(listLabeledVms(config(async () => response(body))));
  const empty = await listLabeledVms(config(async () => response({
    items: { 'zones/us-central1-a': { warning: { code: 'NO_RESULTS_ON_PAGE' } } },
  }), { allowEmpty: true }));
  assert.deepEqual(empty, []);
});

test('late inventory errors, duplicate IDs and page loops never yield partial metrics', async () => {
  for (const later of [response({ error: { message: TOKEN } }, 403),
    response(page([vm('111')])), response(page([], { nextPageToken: 'same' }))]) {
    let calls = 0;
    const run = transport(async () => ++calls === 1
      ? response(page([vm('111')], { nextPageToken: 'same' })) : later);
    const result = await run(args());
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  }
});

test('Monitoring rejects series from other instances, projects or resource types', async () => {
  for (const item of [
    metric('999'), { ...metric('111'), resource: { type: 'gce_instance', labels: { instance_id: '111', project_id: 'wrong-project' } } },
    { ...metric('111'), resource: { type: 'other_resource', labels: { instance_id: '111', project_id: PROJECT } } },
  ]) {
    const run = transport(async (url) => response(url.hostname === 'compute.googleapis.com'
      ? page([vm('111')]) : { timeSeries: [item] }));
    const result = await run(args());
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
  }
});

test('a roster replaced inside the measurement window is refused rather than omitting historical IDs', async () => {
  let monitoring = 0;
  const run = transport(async (url) => {
    if (url.hostname !== 'compute.googleapis.com') monitoring++;
    return response(page([vm('111', 'app', { creationTimestamp: '2026-11-04T01:01:00Z' })]));
  });
  assert.equal((await run(args())).code, 1);
  assert.equal(monitoring, 0);
});

test('selected VMs with no Monitoring samples stay empty, never fabricated zeros', async () => {
  const run = transport(async (url) => response(url.hostname === 'compute.googleapis.com'
    ? page([vm('111')]) : {}));
  assert.equal((await run(args())).stdout, '[]');
});

test('SQL filters bypass inventory and remain byte-identical with raw point values', async () => {
  const filter = sqlMetricFilter('network/connections', 'fixture-db');
  const points = [{ points: [{ value: { int64Value: '30' } }] }];
  const run = transport(async (url) => {
    assert.equal(url.hostname, 'monitoring.googleapis.com');
    assert.equal(url.searchParams.get('filter'), filter);
    return response({ timeSeries: points });
  });
  const input = args().map((arg) => arg.startsWith('--filter=') ? `--filter=${filter}` : arg);
  assert.equal((await run(input)).stdout, JSON.stringify(points));
});

test('only the original app/generator label grammar is translated; no selector injection', () => {
  assert.deepEqual(parseVmCpuSelector(vmCpuFilter('app', TEST_ID)), { role: 'app', testId: TEST_ID });
  assert.equal(parseVmCpuSelector(sqlMetricFilter('cpu/utilization', 'db')), null);
  assert.throws(() => parseVmCpuSelector(vmCpuFilter('other', TEST_ID)));
  assert.throws(() => parseVmCpuSelector(vmCpuFilter('app', `${TEST_ID}" OR true`)));
  assert.throws(() => rawVmCpuFilter([]));
});

test('inventory probe fails closed on credentials, API denial or unreachable scopes', async () => {
  for (const options of [
    { getAccessToken: async () => { throw Error(TOKEN); } },
    { fetchFn: async () => response({ error: { message: TOKEN } }, 403) },
    { fetchFn: async () => response({ unreachables: ['zone'] }) },
  ]) {
    const result = await gcpVmInventoryProbe({ project: PROJECT, testId: TEST_ID,
      getAccessToken: async () => TOKEN, ...options });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  }
});
