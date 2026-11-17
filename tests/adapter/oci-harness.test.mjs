import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dispatch } from '../../scripts/lib/adapter/main.mjs';
import { getScenario } from '../../scripts/lib/adapter/scenarios.mjs';
import { assertConfiguration, noLoadAcceptance } from '../../scripts/lib/adapter/oci.mjs';
import { launchCommand, ssh, ociJson, safeOci } from '../../scripts/lib/adapter/oci-commands.mjs';
import { billedCost, csv, summarizeMetric } from '../../scripts/lib/adapter/oci-evidence.mjs';
import { cleanup, makeManifest, ownedState } from '../../scripts/lib/adapter/oci-cleanup.mjs';

const campaignId = 'oci-holdout-v1-r1-ad1-20261120';
const pin = '1'.repeat(40);
const fields = () => ({
  cloud: 'oci', region: 'us-ashburn-1', compartment_id: 'private-compartment',
  compartment_name: 'cwm-bench-oci', availability_domain: 'runtime:US-ASHBURN-AD-1',
  test_id: campaignId, measurement_sha: pin, generator_id: 'gen',
  generator_ip: '192.0.2.3', app_ids: ['app0', 'app1'],
  app_ips: ['192.0.2.1', '192.0.2.2'], db_id: 'db', db_configuration_id: 'config', lb_id: 'lb',
  target: 'http://192.0.2.4', scored_resource_ids: ['app0', 'app1', 'db', 'lb'],
  generator_resource_ids: ['gen'],
  expected: {
    app_count: 2, shape: 'VM.Standard.E4.Flex', ocpus: 2, memory_gb: 16,
    profile: 'lean', pool: 250, workers: 1, node_major: 20,
    db_shape: 'MySQL.2', db_storage_gb: 100, max_connections: 1000,
    heatwave: false, ha: false, backups: false, delete_protected: false,
    final_backup: 'SKIP_FINAL_BACKUP', k6: 'v0.54.0', lb_min: 10, lb_max: 100,
  },
});

function harness() {
  const f = fields(); let state = '{}', current, launch = 0, recovered = 0;
  const calls = [];
  const ctx = {
    env: { CWM_CLOUD: 'oci', CWM_CAMPAIGN_ID: campaignId,
      CWM_OCI_SSH_KEY: '/private/key', CWM_OCI_KNOWN_HOSTS: '/private/hosts' },
    statePath: '/private/state', now: () => new Date('2026-11-20T00:00:00Z'),
    deps: {
      fs: { readFile: async () => state, writeFile: async (_, bytes) => { state = bytes; }, mkdir: async () => {} },
      ociLock: async () => async () => {},
      persistOciManifest: async () => {},
      wait: async () => {},
      runAws: () => { throw new Error('AWS called'); },
      runGcloud: () => { throw new Error('GCP called'); },
      runTerraform: () => { throw new Error('AWS Terraform called'); },
      runOciTerraform: async () => ({ code: 0, stdout: JSON.stringify(f) }),
      runOci: async (args) => {
        calls.push(args);
        let data;
        if (args[0] === 'compute') data = {
          'lifecycle-state': 'RUNNING', 'compartment-id': f.compartment_id,
          'availability-domain': f.availability_domain, shape: f.expected.shape,
          'shape-config': { ocpus: 2, 'memory-in-gbs': 16 }, 'freeform-tags': { test_id: campaignId },
        };
        else if (args[0] === 'mysql' && args[1] === 'db-system') data = {
          'lifecycle-state': 'ACTIVE', 'compartment-id': f.compartment_id,
          'availability-domain': f.availability_domain, 'shape-name': 'MySQL.2',
          'data-storage-size-in-gb': 100, 'is-highly-available': false,
          'is-heat-wave-cluster-attached': false, 'backup-policy': { 'is-enabled': false },
          'deletion-policy': { 'is-delete-protected': false, 'final-backup': 'SKIP_FINAL_BACKUP' },
          'configuration-id': 'config', 'mysql-version': '8.4.7', 'freeform-tags': { test_id: campaignId },
        };
        else if (args[0] === 'mysql') data = { variables: { 'max-connections': 1000 } };
        else if (args[0] === 'lb' && args[1] === 'load-balancer') data = {
          'lifecycle-state': 'ACTIVE', 'compartment-id': f.compartment_id,
          shape: 'flexible', 'is-private': false,
          'shape-details': { 'minimum-bandwidth-in-mbps': 10, 'maximum-bandwidth-in-mbps': 100 },
          listeners: { http: { protocol: 'HTTP', port: 80 } }, 'freeform-tags': { test_id: campaignId },
        };
        else if (args[0] === 'lb') data = { status: 'OK', 'total-backend-count': 2 };
        else if (args[0] === 'monitoring' && args[1] === 'metric') data = [{ dimensions: { resourceID: 'db' } }];
        else if (args[0] === 'monitoring') data = [{
          'aggregated-datapoints': [{ timestamp: '2026-11-20T00:06:00Z', value: 12 }],
        }];
        else throw new Error('unexpected cloud call');
        return { code: 0, stdout: JSON.stringify({ data }) };
      },
      runOciSsh: async (_, opts) => {
        const script = opts.input;
        let stdout;
        if (script.includes('systemd-run')) { launch++; stdout = ''; }
        else if (script.includes('OCI_RUNNING')) stdout = JSON.stringify(current);
        else if (script.includes('OCI_RAW_PY')) {
          recovered++;
          stdout = JSON.stringify({ identity: current, rawSha256: 'a'.repeat(64), rawBytes: 2000,
            steady: { rawSamples: 9000, totalLossPct: 3 }, whole: { rawSamples: 11000 } });
        } else if (script.includes('/api/meta')) stdout = `v20.19.0\n1000\t8.4.7\n${JSON.stringify({ poolSize: 250, gitSha: pin })}`;
        else stdout = `k6 v0.54.0 (go)\n${pin}\n`;
        return { code: 0, stdout };
      },
    },
  };
  const select = (rps) => {
    ctx.env.CWM_SCENARIO = `oci-holdout-${rps}`;
    ctx.env.CWM_RUN_ID = `run-${rps}`;
    current = { campaignId, runId: ctx.env.CWM_RUN_ID, scenario: ctx.env.CWM_SCENARIO,
      measurementSha: pin, exitCode: 0,
      startedAt: '2026-11-20T00:00:00Z', endedAt: '2026-11-20T00:20:01Z' };
  };
  return { ctx, f, calls, select, state: () => JSON.parse(state), launched: () => launch,
    recovered: () => recovered, marker: () => current };
}

test('all four OCI keys execute and collect via OCI only with their own identities', async () => {
  const h = harness();
  for (const rps of [10, 100, 500, 1000]) {
    h.select(rps);
    const run = await dispatch({ command: 'run', scenario: h.ctx.env.CWM_SCENARIO }, h.ctx);
    assert.equal(run.ok, true);
    assert.equal(run.scenario, `oci-holdout-${rps}`);
    const collected = await dispatch({ command: 'collect', scenario: h.ctx.env.CWM_SCENARIO }, h.ctx);
    assert.equal(collected.ok, true);
    assert.equal(collected.cost.usdPerHour, null);
    assert.equal(collected.saturated, true); // saturation is not a runner fault
    assert.equal(collected.monitoring.dbConnections.max, 12);
  }
  assert.equal(h.launched(), 4);
  assert.equal(h.recovered(), 8);
  const queryArgs = h.calls.filter((a) => a.includes('--query-text')).map((a) => a[a.indexOf('--query-text') + 1]);
  assert.ok(queryArgs.some((q) => q.startsWith('CPUUtilization[1m]{resourceID=')));
  assert.ok(queryArgs.some((q) => q.startsWith('peakBandwidth') && q.includes('lbComponent="loadBalancer"')));
  assert.deepEqual(h.state().oci[campaignId].history.map((r) => r.rps), [10, 100, 500, 1000]);
});

test('no-load acceptance is pure and preserves ladder and script identity', () => {
  assert.deepEqual(noLoadAcceptance().map((r) => r.SCENARIO), [10, 100, 500, 1000].map((r) => `oci-holdout-${r}`));
  assert.ok(noLoadAcceptance().every((r) => r.script === 'load/oci-holdout.js' && r.noLoad && r.cloudCalls === 0));
});

test('runtime topology, timing, apply identity and pin reject drift', () => {
  const h = harness(), spec = getScenario('oci-holdout-10');
  assertConfiguration(h.f, spec, h.ctx.env);
  for (const mutate of [
    (f) => { f.test_id = 'oci-holdout-v1-r1-ad4-20261120'; },
    (f) => { f.test_id = 'oci-holdout-v1-r1-ad1-20260230'; },
    (f) => { f.expected.pool = 100; }, (f) => { f.expected.heatwave = true; },
    (f) => { f.availability_domain = 'AD-2'; }, (f) => { f.app_ids = ['app0']; },
    (f) => { f.measurement_sha = 'main'; },
  ]) {
    const f = fields(); mutate(f);
    assert.throws(() => assertConfiguration(f, spec, h.ctx.env));
  }
  assert.throws(() => assertConfiguration(fields(), spec, { ...h.ctx.env, CWM_WARMUP: '1s' }));
});

test('ladder skips/repeats, changed apply resources and failed generators cannot rerun', async () => {
  const h = harness();
  h.select(100);
  await assert.rejects(dispatch({ command: 'run', scenario: 'oci-holdout-100' }, h.ctx), { code: 'LADDER_ORDER' });
  assert.equal(h.launched(), 0);
  h.select(10);
  h.marker().exitCode = 7;
  await assert.rejects(dispatch({ command: 'run', scenario: 'oci-holdout-10' }, h.ctx), { code: 'OCI_GENERATOR_FAILED' });
  h.marker().exitCode = 0;
  await assert.rejects(dispatch({ command: 'run', scenario: 'oci-holdout-10' }, h.ctx), { code: 'OCI_APPLY_FAULTED' });
  const good = harness(); good.select(10);
  await dispatch({ command: 'run', scenario: 'oci-holdout-10' }, good.ctx);
  good.select(100); good.f.db_id = 'replacement-db';
  await assert.rejects(dispatch({ command: 'run', scenario: 'oci-holdout-100' }, good.ctx), { code: 'OCI_APPLY_STATE_MISMATCH' });
});

test('launch detaches with atomic run-once directory and persists marker/raw independently', () => {
  const identity = { campaignId, runId: 'run-10', scenario: 'oci-holdout-10' };
  const script = launchCommand(fields(), identity);
  assert.match(script, /systemd-run/);
  assert.match(script, /SCENARIO=/);
  assert.match(script, /oci-holdout\.js/);
  assert.match(script, /WARMUP=300s DURATION=900s/);
  assert.match(script, /gzip -f k6.json/);
  assert.match(script, /os.rename/);
  assert.doesNotMatch(script, /pkill|killall|timeout 1200/);
  assert.throws(() => launchCommand(fields(), { ...identity, runId: '../escape' }));
});

test('SSH reconnects without killing k6, is bounded, and deterministic failures do not retry', async () => {
  const h = harness(), delays = [], evidence = []; let calls = 0;
  h.ctx.deps.wait = async (ms) => delays.push(ms);
  h.ctx.deps.runOciSsh = async (args, opts) => {
    assert.ok(args.includes('-oStrictHostKeyChecking=yes'));
    assert.equal(opts.input, 'read marker');
    return ++calls < 3 ? { code: 255 } : { code: 0, stdout: 'complete' };
  };
  assert.equal(await ssh(h.ctx, '192.0.2.3', 'read marker', { evidence }), 'complete');
  assert.equal(evidence.length, 2);
  assert.deepEqual(delays, [1000, 2000]);
  h.ctx.deps.runOciSsh = async () => ({ code: 255 });
  await assert.rejects(ssh(h.ctx, '192.0.2.3', 'read marker'), { code: 'OCI_RECONNECT_EXHAUSTED' });
  h.ctx.deps.runOciSsh = async () => ({ code: 1 });
  await assert.rejects(ssh(h.ctx, '192.0.2.3', 'read marker'), { code: 'OCI_SSH_FAILED' });
});

test('OCI API retries only bounded transient errors, never exposes private failure bytes', async () => {
  const h = harness(); let n = 0;
  h.ctx.deps.runOci = async () => ++n < 3 ? { code: 1, stderr: '429' } : { code: 0, stdout: '{"data":{"ok":true}}' };
  assert.deepEqual(await ociJson(h.ctx, ['read']), { ok: true });
  h.ctx.deps.runOci = async () => ({ code: 1, stderr: 'private credential bytes 403' });
  await assert.rejects(ociJson(h.ctx, ['read']), (e) => !e.message.includes('private credential'));
});

test('nearest-rank raw steady/whole windows retain non-double-counted error evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-raw-test-'));
  try {
    const marker = { campaignId, runId: 'test', scenario: 'oci-holdout-10',
      startedAt: '2026-11-20T00:00:00Z', endedAt: '2026-11-20T00:20:01Z', exitCode: 0 };
    const points = [], tags = { campaign_id: campaignId, run_id: 'test', phase: 'steady' };
    const point = (metric, value, second, extra = {}) => points.push(JSON.stringify({
      type: 'Point', metric, data: { value, time: new Date(Date.parse(marker.startedAt) + second * 1000).toISOString(), tags: { ...tags, ...extra } },
    }));
    for (const [n, status, error_code] of [[0, '200', ''], [1, '500', '1500'],
      [2, '0', '1050'], [3, '0', '1220'], [4, '0', '1212'], [5, '200', '1100']]) {
      point('http_req_duration', n + 1, 301 + n, { status, error_code });
      point('http_reqs', 1, 301 + n);
      point('http_req_failed', n ? 1 : 0, 301 + n);
    }
    point('http_req_duration', 999, 299, { status: '200' }); point('http_reqs', 1, 299); point('http_req_failed', 0, 299);
    point('dropped_iterations', 2, 400);
    await writeFile(path.join(dir, 'raw.json'), `${points.join('\n')}\n`);
    await writeFile(path.join(dir, 'marker.json'), JSON.stringify(marker));
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ metrics: {
      http_reqs: { values: { count: 7 } }, dropped_iterations: { values: { count: 2 } },
    } }));
    const run = () => spawnSync('python3', ['scripts/lib/adapter/oci-raw.py', path.join(dir, 'raw.json'), path.join(dir, 'marker.json')], { encoding: 'utf8' });
    const r = run(); assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.steady.p50Ms, 3); assert.equal(data.steady.p95Ms, 6); assert.equal(data.whole.p99Ms, 999);
    assert.equal(data.steady.denominator, 8); assert.equal(data.steady.lossCount, 7);
    assert.equal(data.steady.hardErrorDenominator, 6); assert.equal(data.steady.hardErrors, 5);
    assert.equal(data.steady.classes.transportOther, 1); assert.equal(data.steady.throughputRps, 6 / 900);
    await writeFile(path.join(dir, 'raw.json'), points.slice(0, -2).join('\n'));
    assert.notEqual(run().status, 0); // truncated request streams cannot score
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('billing requires all scored resource coverage, excludes generator and preserves null', () => {
  const f = fields(), start = '2026-11-20T00:00:00Z', end = '2026-11-20T01:00:00Z';
  const rows = [...f.scored_resource_ids, 'gen'].map((id, i) => ({
    'product/resourceId': id, 'cost/currencyCode': 'USD', 'cost/myCost': id === 'gen' ? '999' : '.1',
    'lineItem/referenceNo': String(i), 'lineItem/intervalUsageStart': start, 'lineItem/intervalUsageEnd': end,
  }));
  assert.equal(billedCost(rows, f, start, end).usdPerHour, .4);
  assert.equal(billedCost(rows.slice(1), f, start, end).usdPerHour, null);
  assert.equal(billedCost([], f, start, end).usdPerHour, null);
  assert.equal(billedCost([...rows, rows[0]], f, start, end).usdPerHour, null);
  assert.deepEqual(csv('a,b\n"x,y","a""b"\n'), [{ a: 'x,y', b: 'a"b' }]);
});

test('monitoring excludes buckets outside recorded steady bounds', () => {
  const r = summarizeMetric([{ 'aggregated-datapoints': [
    { timestamp: '2026-11-20T00:04:00Z', value: 100 },
    { timestamp: '2026-11-20T00:06:00Z', value: 12 },
    { timestamp: '2026-11-20T00:19:45Z', value: 99 },
  ] }], '2026-11-20T00:05:30Z', '2026-11-20T00:20:00Z');
  assert.deepEqual(r, { avg: 12, max: 12, count: 1 });
});

test('OCI redaction covers actual serialized IDs, keys and fingerprints', () => {
  const id = ['ocid1', 'instance', 'oc1', 'iad', 'privateValue'].join('.');
  const fingerprint = Array(16).fill('ab').join(':');
  const key = ['-----BEGIN PRIVATE KEY-----', 'privateBytes', '-----END PRIVATE KEY-----'].join('\n');
  const text = JSON.stringify(safeOci({ id, fingerprint, key }));
  assert.ok(!text.includes('privateValue'));
  assert.ok(!text.includes(fingerprint));
  assert.ok(!text.includes('privateBytes'));
});

test('cleanup refuses foreign state, variable drift and early sweeps; never force-deletes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-cleanup-test-'));
  try {
    const variableFile = path.join(dir, 'runtime.json');
    await writeFile(variableFile, '{}');
    assert.throws(() => ownedState({ resources: [{ type: 'oci_core_instance', instances: [{ attributes: { id: 'unrelated', freeform_tags: {} } }] }] }, campaignId));
    const manifest = { testId: campaignId, compartmentId: 'private-compartment', lineage: 'lineage',
      variableFile, variableSha256: createHash('sha256').update('{}').digest('hex'), resourceIds: ['owned'], dbId: 'db' };
    const h = harness(), commands = [];
    h.ctx.deps.runOciTerraform = async (args) => {
      commands.push(args); return { code: 0, stdout: JSON.stringify({ lineage: 'lineage', resources: [] }) };
    };
    h.ctx.deps.runOci = async (args) => {
      commands.push(args);
      if (args[0] === 'search') return { code: 0, stdout: JSON.stringify({ data: { items: [
        { 'resource-type': 'Instance', identifier: 'owned', 'lifecycle-state': 'RUNNING' },
        { 'resource-type': 'Vcn', identifier: 'unrelated', 'lifecycle-state': 'AVAILABLE' },
      ] } }) };
      throw new Error('unexpected deletion');
    };
    const result = await cleanup(h.ctx, manifest, 'immediate');
    assert.equal(result.report.ownedRemaining, 1);
    assert.equal(result.report.residuals.length, 2);
    assert.equal(result.report.unrelatedDeletionAllowed, false);
    assert.ok(commands.some((c) => c[0] === 'destroy' && c.includes(`-var-file=${variableFile}`)));
    assert.ok(!commands.some((c) => c.includes('delete') || c.includes('terminate')));
    await assert.rejects(cleanup(h.ctx, manifest, '24h'), { code: 'OCI_CLEANUP_TOO_EARLY' });
    await writeFile(variableFile, '{"drift":true}');
    await assert.rejects(cleanup(h.ctx, manifest, 'immediate'), { code: 'OCI_CLEANUP_VARIABLE_DRIFT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cleanup accepts only owned untaggable children and supports partial-apply manifests', async () => {
  const tagged = (type, name, id) => ({ type, name, instances: [{ attributes: { id, freeform_tags: { test_id: campaignId } } }] });
  const parent = tagged('oci_load_balancer_load_balancer', 'main', 'lb');
  const child = { type: 'oci_load_balancer_listener', name: 'http', instances: [{ attributes: { id: 'listener', load_balancer_id: 'lb' } }] };
  assert.deepEqual(ownedState({ resources: [parent, child] }, campaignId), ['lb', 'listener']);
  child.instances[0].attributes.load_balancer_id = 'foreign';
  assert.throws(() => ownedState({ resources: [parent, child] }, campaignId), { code: 'OCI_CLEANUP_UNOWNED_STATE' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-partial-test-'));
  try {
    const variableFile = path.join(dir, 'runtime.tfvars.json');
    await writeFile(variableFile, JSON.stringify({
      compartment_id: 'private-compartment', tenancy_id: 'private-tenancy',
      availability_domain: 'runtime:US-ASHBURN-AD-1', image_id: 'private-image',
      ssh_public_key: 'temporary-public-key', controller_cidr: '192.0.2.1/32',
      budget_recipients: 'test@example.invalid', test_id: campaignId, measurement_sha: pin,
    }));
    const h = harness();
    h.ctx.deps.runOciTerraform = async () => ({ code: 0, stdout: JSON.stringify({
      lineage: 'partial-lineage', resources: [tagged('oci_core_vcn', 'main', 'vcn')],
    }) });
    h.ctx.deps.runOci = async () => ({ code: 0, stdout: '{"data":{"name":"cwm-bench-oci"}}' });
    const manifest = await makeManifest(h.ctx, null, variableFile);
    assert.equal(manifest.dbId, null);
    assert.deepEqual(manifest.resourceIds, ['vcn']);
    assert.equal(manifest.lineage, 'partial-lineage');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('delayed sweep checks backup and Cost Analysis without issuing destroy or deleting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-delayed-test-'));
  try {
    const variableFile = path.join(dir, 'runtime.json'); await writeFile(variableFile, '{}');
    const manifest = { testId: campaignId, compartmentId: 'private-compartment',
      variableFile, variableSha256: createHash('sha256').update('{}').digest('hex'),
      resourceIds: ['owned'], dbId: 'db', lastDestroyOk: true,
      terraformStateEmpty: true,
      firstDestroyAt: '2026-11-18T00:00:00Z', destroyedAt: '2026-11-18T00:00:00Z' };
    const h = harness(), calls = [];
    h.ctx.deps.runOciTerraform = async () => { throw new Error('delayed sweep must be read-only'); };
    h.ctx.deps.runOci = async (args) => {
      calls.push(args);
      const data = args[0] === 'search' ? { items: [] } : args[0] === 'mysql' ? [] : { items: [] };
      return { code: 0, stdout: JSON.stringify({ data }) };
    };
    const result = await cleanup(h.ctx, manifest, '24h');
    assert.equal(result.report.inventoryClean, true);
    assert.deepEqual(result.report.backups, []);
    assert.equal(result.report.stoppedCharges.observedCost, null);
    assert.equal(result.report.stoppedCharges.verified, false);
    assert.ok(calls.some((c) => c[0] === 'mysql' && c.includes('--db-system-id')));
    assert.ok(calls.some((c) => c[0] === 'usage-api'));
    assert.ok(calls.every((c) => !c.includes('delete') && !c.includes('destroy')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed destroy schedules retries even when Search is empty or lagging', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-retry-test-'));
  try {
    const variableFile = path.join(dir, 'runtime.json'); await writeFile(variableFile, '{}');
    const manifest = { testId: campaignId, compartmentId: 'private-compartment', lineage: 'lineage',
      variableFile, variableSha256: createHash('sha256').update('{}').digest('hex'), resourceIds: ['budget'], dbId: null };
    const h = harness(), saved = [];
    h.ctx.deps.persistOciManifest = async (m) => saved.push(structuredClone(m));
    h.ctx.deps.runOciTerraform = async (args) => {
      if (args[0] === 'destroy') {
        assert.equal(saved[0].firstDestroyAt, '2026-11-20T00:00:00.000Z');
        assert.ok(saved[0].nextDestroyRetryAt);
        return { code: 1 };
      }
      return { code: 0, stdout: JSON.stringify({ lineage: 'lineage', resources: [{
        type: 'oci_budget_budget', name: 'main', instances: [{
          attributes: { id: 'budget', freeform_tags: { test_id: campaignId } },
        }],
      }] }) };
    };
    h.ctx.deps.runOci = async () => ({ code: 0, stdout: '{"data":{"items":[]}}' });
    const result = await cleanup(h.ctx, manifest, 'immediate');
    assert.equal(result.report.destroyOk, false);
    assert.equal(result.report.ownedRemaining, 0);
    assert.equal(result.report.terraformStateEmpty, false);
    assert.equal(result.report.inventoryClean, false);
    assert.equal(result.report.nextDestroyRetryAt, '2026-11-20T02:00:00.000Z');
    assert.equal(saved.at(-1).lastDestroyOk, false);
    assert.equal(saved.at(-1).nextDestroyRetryAt, result.report.nextDestroyRetryAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Search failure after successful destroy preserves durable timestamps and retries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-search-failure-test-'));
  try {
    const variableFile = path.join(dir, 'runtime.json'), file = path.join(dir, 'manifest.json');
    await writeFile(variableFile, '{}');
    const manifest = { testId: campaignId, compartmentId: 'private-compartment', lineage: 'lineage',
      variableFile, variableSha256: createHash('sha256').update('{}').digest('hex'), resourceIds: [], dbId: null };
    const h = harness();
    h.ctx.deps.persistOciManifest = async (m) => writeFile(file, JSON.stringify(m));
    h.ctx.deps.runOciTerraform = async (args) => {
      if (args[0] === 'destroy') {
        const before = JSON.parse(await readFile(file, 'utf8'));
        assert.ok(before.firstDestroyAt);
        assert.equal(before.lastDestroyOk, false);
        return { code: 0 };
      }
      return { code: 0, stdout: '{"lineage":"lineage","resources":[]}' };
    };
    h.ctx.deps.runOci = async () => {
      const before = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(before.lastDestroyOk, true);
      assert.equal(before.destroyedAt, '2026-11-20T00:00:00.000Z');
      assert.ok(before.nextDestroyRetryAt);
      throw new Error('Search unavailable');
    };
    const result = await cleanup(h.ctx, manifest, 'immediate');
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(result.report.searchOk, false);
    assert.equal(result.report.inventoryClean, false);
    assert.equal(result.report.residuals, null);
    assert.equal(after.firstDestroyAt, '2026-11-20T00:00:00.000Z');
    assert.equal(after.destroyedAt, after.firstDestroyAt);
    assert.equal(after.nextDestroyRetryAt, '2026-11-20T02:00:00.000Z');
    assert.equal(result.report.delayedSweepAt, '2026-11-21T00:00:00.000Z');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
