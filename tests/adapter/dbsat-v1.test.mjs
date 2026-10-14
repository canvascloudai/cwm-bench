import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { getScenario, SCENARIO_KEYS } from '../../scripts/lib/adapter/scenarios.mjs';
import { DBSAT_LADDER, DBSAT_TEST_ID_RE } from '../../scripts/lib/adapter/ladder.mjs';
import { generatorPlan, parseK6Status, teardownCommand } from '../../scripts/lib/adapter/run.mjs';
import {
  collectPerformanceInsights,
  collectPoolMetrics,
  mergeSteady,
  parseSteady,
  steadyCommand,
} from '../../scripts/lib/adapter/dbsat-collect.mjs';
import { ADAPTER_VERSION } from '../../scripts/lib/adapter/version.mjs';
import { localSsmText } from '../remote-text-helper.mjs';
import { MemoryStream, createAwsMock, ssmOnlineHandlers, terraformOutputFixture } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const META = { poolSize: 250, profile: 'typical', workers: 2 };

function memoryFs() {
  const files = new Map();
  return {
    readFile: async (file) => {
      if (!files.has(file)) {
        const err = new Error('no state');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(file);
    },
    writeFile: async (file, body) => {
      files.set(file, String(body));
    },
    mkdir: async () => {},
  };
}

function dbsatTerraform(appCount, testId, generators = ['i-gen1']) {
  const ids = Array.from({ length: appCount }, (_, index) => `i-db${index + 1}`);
  return terraformOutputFixture({
    generator_instance_id: { value: generators[0] },
    generator_instance_ids: { value: generators },
    rds_resource_id: { value: 'db-ABCDEFGHIJKL' },
    performance_insights_enabled: { value: true },
    app_instance_ids: { value: ids },
    app_root_volume_ids: { value: ids.map((_, index) => `vol-db${index + 1}`) },
    topology_declaration: {
      value: { region: 'us-east-2', test_id: testId, app_pool_size: 250, app_count: appCount },
    },
  });
}

async function runWith(argv, { env, ...options }) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(argv, { stdout, stderr, ...options, env });
  let payload;
  try {
    payload = JSON.parse(stdout.toString());
  } catch {
    payload = { raw: stdout.toString() };
  }
  return { code, payload, stdout: stdout.toString() };
}

function sentScripts(aws) {
  return aws.calls
    .filter((args) => args[0] === 'ssm' && args[1] === 'send-command')
    .map((send) => ({
      instance: send[send.indexOf('--instance-ids') + 1],
      script: JSON.parse(send[send.indexOf('--parameters') + 1]).commands.join('\n'),
    }));
}

test('adapter is 1.7.1 with 21 ascending dbsat keys at 2x/3x/4x', () => {
  assert.equal(ADAPTER_VERSION, '1.7.1');
  const keys = SCENARIO_KEYS.filter((key) => key.startsWith('typical-dbsat-'));
  assert.equal(keys.length, 21);
  assert.deepEqual(DBSAT_LADDER, [300, 500, 700, 900, 1100, 1300, 1500]);
  for (const n of [2, 3, 4]) {
    for (const rps of DBSAT_LADDER) {
      const spec = getScenario(`typical-dbsat-${n}x-${rps}`);
      assert.equal(spec.rps, rps);
      assert.equal(spec.expectedAppCount, n);
      assert.ok(spec.steadyP95AtCollect && spec.partialStep && spec.multiGenerator);
    }
  }
});

test('dbsat test ids: discovery r1/r2, confirmation c1, dry run d1', () => {
  for (const id of ['typical-dbsat-2x-r1-20261013', 'typical-dbsat-4x-r2-20261014',
    'typical-dbsat-3x-c1-20261015', 'typical-dbsat-3x-d1-20261013', 'typical-dbsat-2x-r1b-20261016']) {
    assert.match(id, DBSAT_TEST_ID_RE);
  }
  for (const id of ['typical-dbsat-1x-r1-20261013', 'typical-dbsat-5x-r1-20261013', 'typical-dbsat-2x-r3-20261013']) {
    assert.doesNotMatch(id, DBSAT_TEST_ID_RE);
  }
});

test('dbsat run starts at 300, splits across two generators, scales VUs', async () => {
  const fs = memoryFs();
  const campaign = 'typical-dbsat-2x-d1-20261013';
  const deps = {
    runTerraform: async () => ({ code: 0, stdout: dbsatTerraform(2, campaign, ['i-gen1', 'i-gen2']), stderr: '' }),
    fs,
  };
  const env = (scenario) => ({
    CWM_CAMPAIGN_ID: campaign, CWM_SCENARIO: scenario, CWM_RUN_ID: `${scenario}-d1`,
  });
  const early = createAwsMock(ssmOnlineHandlers({ meta: META }));
  const rejected = await runWith(['run', '--scenario', 'typical-dbsat-2x-500', '--json'], {
    now: () => new Date('2026-10-13T00:00:00Z'), statePath: '/tmp/dbsat-a.json', deps: { ...deps, runAws: early }, env: env('typical-dbsat-2x-500'),
  });
  assert.equal(rejected.payload.error.code, 'LADDER_ORDER');

  const aws = createAwsMock(ssmOnlineHandlers({ meta: META }));
  const result = await runWith(['run', '--scenario', 'typical-dbsat-2x-300', '--json'], {
    now: () => new Date('2026-10-13T00:10:00Z'), statePath: '/tmp/dbsat-a.json', deps: { ...deps, runAws: aws }, env: env('typical-dbsat-2x-300'),
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.stepStatus, 'complete');
  assert.deepEqual(result.payload.generators, ['i-gen1', 'i-gen2']);
  assert.deepEqual(result.payload.ladder, DBSAT_LADDER);
  const k6 = sentScripts(aws).filter((entry) => entry.script.includes('k6 run'));
  assert.deepEqual(k6.map((entry) => entry.instance), ['i-gen1', 'i-gen2']);
  assert.match(k6[0].script, /export K6_SEGMENT='0:1\/2'/);
  assert.match(k6[1].script, /export K6_SEGMENT='1\/2:1'/);
  assert.match(k6[0].script, /export VU_PRE_S='0.5'/);
  assert.match(k6[0].script, /export VU_MAX_S='2.5'/);
});

test('one generator runs the whole rate without segments', () => {
  const plan = generatorPlan(getScenario('typical-dbsat-3x-700'), { generatorInstanceId: 'i-g', generatorInstanceIds: ['i-g'] });
  assert.deepEqual(plan, [{ instanceId: 'i-g', env: {} }]);
  const p95 = generatorPlan(getScenario('typical-p95-2x-300'), { generatorInstanceId: 'i-g', generatorInstanceIds: ['i-g', 'i-h'] });
  assert.equal(p95.length, 1, 'non-dbsat keys never split');
});

test('a controller breach stop is a partial step (overload observation), not a failure', async () => {
  assert.deepEqual(parseK6Status('ADAPTER_K6_STOPPED {"reason":"breach","at":"x"}\nADAPTER_K6_COMPLETE exit=105').state, 'stopped');
  const stopScript = teardownCommand({ campaignId: 'c', runId: 'r', stopReason: 'breach' });
  assert.match(stopScript, /stopped\.json/);
  assert.match(stopScript, /pkill -INT -P "\$PID" -x k6/);
  assert.doesNotMatch(teardownCommand({ campaignId: 'c', runId: 'r' }), /stopped\.json/);

  const campaign = 'typical-dbsat-3x-r1-20261013';
  const base = ssmOnlineHandlers({ meta: META });
  const scripts = new Map();
  const aws = createAwsMock({
    ...base,
    'ssm.send-command': async (args, calls) => {
      const res = await base['ssm.send-command'](args, calls);
      const id = JSON.parse(res.stdout).Command.CommandId;
      scripts.set(id, JSON.parse(args[args.indexOf('--parameters') + 1]).commands.join('\n'));
      return res;
    },
    'ssm.get-command-invocation': async (args, calls) => {
      const id = args[args.indexOf('--command-id') + 1];
      if ((scripts.get(id) || '').includes('# ADAPTER_K6_STATUS_WAIT')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            Status: 'Success',
            StandardOutputContent: 'ADAPTER_K6_STOPPED {"reason":"breach","at":"2026-10-13T01:12:00Z"}\nADAPTER_K6_COMPLETE exit=105',
            StandardErrorContent: '',
            ResponseCode: 0,
          }),
          stderr: '',
        };
      }
      return base['ssm.get-command-invocation'](args, calls);
    },
  });
  const result = await runWith(['run', '--scenario', 'typical-dbsat-3x-300', '--json'], {
    now: () => new Date('2026-10-13T01:00:00Z'),
    statePath: '/tmp/dbsat-b.json',
    deps: {
      runTerraform: async () => ({ code: 0, stdout: dbsatTerraform(3, campaign), stderr: '' }),
      fs: memoryFs(),
      runAws: aws,
    },
    env: { CWM_CAMPAIGN_ID: campaign, CWM_SCENARIO: 'typical-dbsat-3x-300', CWM_RUN_ID: 'typical-dbsat-3x-300-r1' },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.stepStatus, 'overload observation');
  assert.equal(result.payload.partialStep.reason, 'breach');
});

function k6Ndjson(points) {
  return points.map(([metric, time, value, phase]) => JSON.stringify({
    metric, type: 'Point', data: { time, value, tags: { phase } },
  })).join('\n') + '\n';
}

test('steady_p95.py: nearest rank over phase=steady only, per-minute audit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbsat-steady-'));
  const points = [];
  for (let i = 1; i <= 100; i += 1) {
    const time = `2026-10-13T01:0${i <= 50 ? 5 : 6}:00Z`;
    points.push(['http_req_duration', time, i, 'steady']);
    points.push(['http_req_failed', time, i > 98 ? 1 : 0, 'steady']);
  }
  points.push(['http_req_duration', '2026-10-13T01:00:00Z', 99999, 'warmup']);
  writeFileSync(path.join(dir, 'k6.json.gz'), gzipSync(k6Ndjson(points)));
  const out = JSON.parse(execFileSync('python3', [path.join(ROOT, 'scripts/lib/adapter/steady_p95.py'), dir], { encoding: 'utf8' }));
  assert.equal(out.n, 100);
  assert.equal(out.steadyP95Ms, 95);
  assert.equal(out.perMinute.length, 2);
  assert.equal(out.perMinute[1].failed, 2);
  const merged = mergeSteady([out, out]);
  assert.equal(merged.n, 200);
  assert.ok(merged.steadyP95Ms >= 95 && merged.steadyP95Ms <= 95 * 1.0011);
  assert.equal(merged.perMinute[0].requests, 100);
  assert.equal(mergeSteady([out]).exact, true);
});

test('steady command embeds the script and parses markers', () => {
  assert.match(steadyCommand('c', 'r'), /base64 -d > \/tmp\/cwm-steady-p95\.py/);
  const parsed = parseSteady('---STEADY_JSON---\n{"present":true,"n":1}\n---END_STEADY_JSON---\nSTOPPED_JSON={"reason":"breach"}\n');
  assert.equal(parsed.steady.n, 1);
  assert.equal(parsed.stopped.reason, 'breach');
});

test('PI collect queries db.load.avg by wait event type per minute', async () => {
  const aws = createAwsMock({
    'pi.get-resource-metrics': async () => ({
      code: 0,
      stdout: JSON.stringify({ MetricList: [{ Key: { Metric: 'db.load.avg' }, DataPoints: [{ Timestamp: 't', Value: 0.4 }] }] }),
      stderr: '',
    }),
  });
  const window = { startTime: '2026-10-13T01:00:00Z', endTime: '2026-10-13T01:20:00Z' };
  const pi = await collectPerformanceInsights(aws, { rdsResourceId: 'db-X', performanceInsightsEnabled: true }, 'us-east-2', window);
  assert.equal(pi.available, true);
  const args = aws.calls[0];
  assert.equal(args[args.indexOf('--period-in-seconds') + 1], '60');
  assert.match(args[args.indexOf('--metric-queries') + 1], /db\.wait_event_type/);
  const off = await collectPerformanceInsights(aws, { rdsResourceId: 'db-X', performanceInsightsEnabled: false }, 'us-east-2', window);
  assert.equal(off.available, false);
});

test('pool metrics are read per app node and clipped to the window', async () => {
  const body = { gitSha: 'abc', minutes: [{ minute: '2026-10-13T00:59:00.000Z' }, { minute: '2026-10-13T01:05:00.000Z' }] };
  const producer = `printf '%s' '${Buffer.from(JSON.stringify(body)).toString('base64')}' | base64 -d`;
  const aws = localSsmText({ replace: text => text.replace(
    'curl -fsS --max-time 5 http://127.0.0.1:8080/api/metrics', producer) }).runAws;
  const pool = await collectPoolMetrics(aws, { appInstanceIds: ['i-a', 'i-b'] }, 'us-east-2',
    { startTime: '2026-10-13T01:00:00Z', endTime: '2026-10-13T01:20:00Z' }, { ssmPollMs: 1, wait: async () => {} });
  assert.equal(pool.available, true);
  assert.equal(pool.nodes.length, 2);
  assert.deepEqual(pool.nodes[0].minutes.map((row) => row.minute), ['2026-10-13T01:05:00.000Z']);
});
