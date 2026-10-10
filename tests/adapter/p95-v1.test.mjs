import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { parseK6Summary } from '../../scripts/lib/adapter/assemble.mjs';
import { getScenario } from '../../scripts/lib/adapter/scenarios.mjs';
import { ADAPTER_VERSION } from '../../scripts/lib/adapter/version.mjs';
import { MemoryStream, createAwsMock, ssmOnlineHandlers, terraformOutputFixture } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = 'typical-p95-1x-r1-20261012';

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

function p95Terraform(appCount, testId = `typical-p95-${appCount}x-r1-20261012`) {
  const ids = Array.from({ length: appCount }, (_, index) => `i-p95${index + 1}`);
  return terraformOutputFixture({
    app_instance_ids: { value: ids },
    app_root_volume_ids: { value: ids.map((_, index) => `vol-p95${index + 1}`) },
    topology_declaration: {
      value: {
        region: 'us-east-2',
        test_id: testId,
        app_pool_size: 250,
        app_count: appCount,
      },
    },
  });
}

async function runWith(argv, options) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const scenario = argv[argv.indexOf('--scenario') + 1];
  const code = await main(argv, {
    stdout,
    stderr,
    ...options,
    env: {
      CWM_CAMPAIGN_ID: APPLY,
      CWM_RUN_ID: `${scenario}-r1`,
      CWM_SCENARIO: scenario,
      ...(options.env || {}),
    },
  });
  let payload = null;
  try {
    payload = JSON.parse(stdout.toString());
  } catch {
    payload = { raw: stdout.toString() };
  }
  return { code, payload, stdout: stdout.toString() };
}

function k6Script(aws) {
  const scripts = aws.calls
    .filter((args) => args[0] === 'ssm' && args[1] === 'send-command')
    .map((send) => JSON.parse(send[send.indexOf('--parameters') + 1]).commands[0]);
  return scripts.find((entry) => entry.includes('k6 run')) || '';
}

function bothDurations() {
  return {
    metrics: {
      http_req_duration: { values: { med: 40, 'p(95)': 106.48, 'p(99)': 200 } },
      'http_req_duration{phase:steady}': { values: { med: 12, 'p(95)': 40, 'p(99)': 80 } },
      http_reqs: { values: { count: 315000, rate: 300 } },
      http_req_failed: { values: { rate: 0, passes: 0, fails: 315000 } },
      dropped_iterations: { values: { count: 0 } },
      vus: { values: { max: 12 } },
      errors_by_class: { values: { count: 0 } },
    },
  };
}

test('typical-p95 keys are a reverse ladder and are not scale keys', () => {
  assert.equal(ADAPTER_VERSION, '1.6.1');
  for (const [key, appCount, rps] of [
    ['typical-p95-1x-300', 1, 300],
    ['typical-p95-1x-200', 1, 200],
    ['typical-p95-1x-100', 1, 100],
    ['typical-p95-2x-300', 2, 300],
    ['typical-p95-3x-100', 3, 100],
  ]) {
    const spec = getScenario(key);
    assert.equal(spec.rps, rps);
    assert.equal(spec.expectedAppCount, appCount);
    assert.deepEqual(spec.ladder, [300, 200, 100]);
    assert.equal(spec.enforceLadder, true);
    assert.equal(spec.scoreUntaggedDuration, true);
    assert.equal(spec.workload.envValue, key);
    assert.equal(spec.aliasOf, null);
  }
  assert.deepEqual(getScenario('typical-scale-1x-100').ladder, [100, 200, 300]);
  assert.equal(getScenario('typical-scale-1x-100').enforceLadder, false);
  const script = readFileSync(path.join(ROOT, 'load/typical.js'), 'utf8');
  assert.doesNotMatch(script, /thresholds/);
});

test('p95 apply runs 300 then 200 then 100 and records ladder metadata', async () => {
  const fs = memoryFs();
  const statePath = '/tmp/cwm-p95-ladder.json';
  const deps = {
    runTerraform: async () => ({ code: 0, stdout: p95Terraform(1), stderr: '' }),
    fs,
  };
  const early = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const rejected = await runWith(['run', '--scenario', 'typical-p95-1x-200', '--json'], {
    now: () => new Date('2026-10-12T00:00:00.000Z'),
    statePath,
    deps: { ...deps, runAws: early },
  });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.payload.error.code, 'LADDER_ORDER');
  assert.equal(k6Script(early), '');

  const first = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const start = await runWith(['run', '--scenario', 'typical-p95-1x-300', '--json'], {
    now: () => new Date('2026-10-12T00:10:00.000Z'),
    statePath,
    deps: { ...deps, runAws: first },
  });
  assert.equal(start.code, 0, start.stdout);
  assert.equal(start.payload.adapterVersion, '1.6.1');
  assert.deepEqual(start.payload.ladder, [300, 200, 100]);
  assert.equal(start.payload.rung_pos, 1);
  assert.deepEqual(start.payload.ladder_history, [300]);
  const script = k6Script(first);
  assert.match(script, /k6 run --out json="\$RESULTS_DIR\/k6\.json"/);
  assert.match(script, /gzip -nf "\$RESULTS_DIR\/k6\.json"/);
  assert.doesNotMatch(script, /threshold/);

  const skip = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const skipped = await runWith(['run', '--scenario', 'typical-p95-1x-100', '--json'], {
    now: () => new Date('2026-10-12T00:20:00.000Z'),
    statePath,
    deps: { ...deps, runAws: skip },
  });
  assert.equal(skipped.payload.error.code, 'LADDER_ORDER');

  const second = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const mid = await runWith(['run', '--scenario', 'typical-p95-1x-200', '--json'], {
    now: () => new Date('2026-10-12T00:30:00.000Z'),
    statePath,
    deps: { ...deps, runAws: second },
    env: { CWM_RUN_ID: 'typical-p95-1x-200-r1' },
  });
  assert.equal(mid.code, 0, mid.stdout);
  assert.equal(mid.payload.rung_pos, 2);
  assert.deepEqual(mid.payload.ladder_history, [300, 200]);

  const third = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const last = await runWith(['run', '--scenario', 'typical-p95-1x-100', '--json'], {
    now: () => new Date('2026-10-12T00:40:00.000Z'),
    statePath,
    deps: { ...deps, runAws: third },
    env: { CWM_RUN_ID: 'typical-p95-1x-100-r1' },
  });
  assert.equal(last.code, 0, last.stdout);
  assert.equal(last.payload.rung_pos, 3);
  assert.deepEqual(last.payload.ladder_history, [300, 200, 100]);
});

test('p95 rejects a forward ladder, a reused key, a bad test id, and the wrong app count', async () => {
  const meta = { poolSize: 250, profile: 'typical', workers: 2 };
  const forward = createAwsMock(ssmOnlineHandlers({ meta }));
  const forwardResult = await runWith(['run', '--scenario', 'typical-p95-1x-300', '--json'], {
    now: () => new Date('2026-10-12T01:00:00.000Z'),
    deps: {
      runAws: forward,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1), stderr: '' }),
      fs: memoryFs(),
    },
    env: { CWM_LADDER: '100,200,300' },
  });
  assert.equal(forwardResult.payload.error.code, 'LADDER_ORDER');
  assert.equal(k6Script(forward), '');

  const reused = createAwsMock(ssmOnlineHandlers({ meta }));
  const reusedResult = await runWith(['run', '--scenario', 'typical-scale-1x-300', '--json'], {
    now: () => new Date('2026-10-12T01:00:00.000Z'),
    deps: {
      runAws: reused,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1), stderr: '' }),
      fs: memoryFs(),
    },
    env: { CWM_SCENARIO: 'typical-scale-1x-300' },
  });
  assert.equal(reusedResult.payload.error.code, 'REUSED_KEY');

  const badId = createAwsMock(ssmOnlineHandlers({ meta }));
  const badIdResult = await runWith(['run', '--scenario', 'typical-p95-1x-300', '--json'], {
    now: () => new Date('2026-10-12T01:00:00.000Z'),
    deps: {
      runAws: badId,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1, 'typical-scale-1x-r1-20261012'), stderr: '' }),
      fs: memoryFs(),
    },
    env: { CWM_CAMPAIGN_ID: 'typical-scale-1x-r1-20261012' },
  });
  assert.equal(badIdResult.payload.error.code, 'TEST_ID_MISMATCH');

  const mismatch = createAwsMock(ssmOnlineHandlers({ meta }));
  const mismatchResult = await runWith(['run', '--scenario', 'typical-p95-3x-300', '--json'], {
    now: () => new Date('2026-10-12T01:00:00.000Z'),
    deps: {
      runAws: mismatch,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1), stderr: '' }),
      fs: memoryFs(),
    },
    env: {
      CWM_CAMPAIGN_ID: 'typical-p95-3x-r1-20261012',
      CWM_SCENARIO: 'typical-p95-3x-300',
      CWM_RUN_ID: 'typical-p95-3x-300-r1',
    },
  });
  assert.equal(mismatchResult.payload.error.code, 'APP_COUNT_MISMATCH');
});

test('an existing scale key still accepts 300 first and keeps the ascending ladder', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }));
  const result = await runWith(['run', '--scenario', 'typical-scale-1x-300', '--json'], {
    now: () => new Date('2026-10-12T02:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1, 'typical-scale-1x-r1-20261012'), stderr: '' }),
      fs: memoryFs(),
    },
    env: {
      CWM_CAMPAIGN_ID: 'typical-scale-1x-r1-20261012',
      CWM_SCENARIO: 'typical-scale-1x-300',
      CWM_RUN_ID: 'typical-scale-1x-300-r1',
      CWM_LADDER: '300,200,100',
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.payload.ladder, [100, 200, 300]);
  assert.equal(result.payload.rung_pos, 3);
  assert.deepEqual(result.payload.ladder_history, [300]);
  const script = k6Script(aws);
  assert.match(script, /k6 run --out json=/);
  assert.doesNotMatch(script, /gzip/);
  assert.doesNotMatch(script, /threshold/);
});

test('p95 collect scores the untagged aggregate and a scale collect does not switch', async () => {
  const summary = bothDurations();
  const parsed = parseK6Summary(summary, { durationMode: 'untagged' });
  assert.equal(parsed.latency.p95Ms, 106.48);
  assert.equal(parsed.latency.untaggedAggregate, true);
  const picked = parseK6Summary(summary);
  assert.equal(picked.latency.p95Ms, 40);

  const sha = '68b5fa2cc68190717d639bf180d9039a5634e812';

  async function collect(scenario, campaignId, appCount, provenance = {}) {
    const dir = `/opt/cwm-bench/results/raw/${campaignId}/${scenario}-r1`;
    const identity = { campaignId, runId: `${scenario}-r1`, scenario };
    const listing = [
      `ARTIFACT_DIR=${dir}`,
      'summary.json',
      'k6.json.gz',
      'identity.json',
      '---SUMMARY_JSON---',
      JSON.stringify(summary),
      '---END_SUMMARY_JSON---',
      '---IDENTITY_JSON---',
      JSON.stringify(identity),
      '---END_IDENTITY_JSON---',
    ].join('\n');
    const aws = createAwsMock({
      ...ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2 } }),
      'ssm.get-command-invocation': async (args) => {
        const commandId = args[args.indexOf('--command-id') + 1];
        const send = aws.calls.find((call) =>
          call[0] === 'ssm' && call[1] === 'send-command' && call.includes(commandId));
        const script = send
          ? JSON.parse(send[send.indexOf('--parameters') + 1]).commands.join('\n')
          : '';
        const meta = { poolSize: 250, profile: 'typical', workers: 2 };
        if (provenance.gitSha) meta.gitSha = provenance.gitSha;
        const stdout = script.includes('/api/meta') ? JSON.stringify(meta) : listing;
        return {
          code: 0,
          stdout: JSON.stringify({
            Status: 'Success',
            StandardOutputContent: stdout,
            StandardErrorContent: '',
            ResponseCode: 0,
          }),
          stderr: '',
        };
      },
    });
    return runWith(['collect', '--scenario', scenario, '--json'], {
      now: () => new Date('2026-10-12T03:00:00.000Z'),
      deps: {
        runAws: aws,
        runTerraform: async () => ({ code: 0, stdout: p95Terraform(appCount, campaignId), stderr: '' }),
        fs: memoryFs(),
      },
      env: {
        CWM_CAMPAIGN_ID: campaignId,
        CWM_SCENARIO: scenario,
        CWM_RUN_ID: `${scenario}-r1`,
        ...(provenance.measurementSha ? { CWM_MEASUREMENT_SHA: provenance.measurementSha } : {}),
      },
    });
  }

  const p95 = await collect('typical-p95-1x-300', APPLY, 1, { gitSha: sha, measurementSha: sha });
  assert.equal(p95.code, 0, p95.stdout);
  assert.equal(p95.payload.latency.p95Ms, 106.48);
  assert.equal(p95.payload.latency.untaggedAggregate, true);
  assert.equal(p95.payload.latency.metric, 'http_req_duration');
  assert.equal(p95.payload.measurementSha, sha);
  assert.equal(p95.payload.artifacts.requestLevelRaw.present, true);
  assert.ok(p95.payload.artifacts.requestLevelRaw.files.includes('k6.json.gz'));

  const fromEnv = await collect('typical-p95-1x-300', APPLY, 1, { measurementSha: sha });
  assert.equal(fromEnv.code, 0, fromEnv.stdout);
  assert.equal(fromEnv.payload.measurementSha, sha);

  const fromApp = await collect('typical-p95-1x-300', APPLY, 1, { gitSha: sha.toUpperCase() });
  assert.equal(fromApp.code, 0, fromApp.stdout);
  assert.equal(fromApp.payload.measurementSha, sha);

  const scale = await collect('typical-scale-1x-300', 'typical-scale-1x-r1-20261012', 1, {
    gitSha: sha,
    measurementSha: sha,
  });
  assert.equal(scale.code, 0, scale.stdout);
  assert.equal(scale.payload.latency.p95Ms, 40);
  assert.equal(scale.payload.latency.untaggedAggregate, false);
  assert.equal(Object.hasOwn(scale.payload, 'measurementSha'), false);
});

test('p95 collect rejects a measurement SHA that disagrees with the app gitSha', async () => {
  const summary = bothDurations();
  const sha = '68b5fa2cc68190717d639bf180d9039a5634e812';
  const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const campaignId = APPLY;
  const scenario = 'typical-p95-1x-300';
  const dir = `/opt/cwm-bench/results/raw/${campaignId}/${scenario}-r1`;
  const listing = [
    `ARTIFACT_DIR=${dir}`,
    'summary.json',
    'k6.json.gz',
    'identity.json',
    '---SUMMARY_JSON---',
    JSON.stringify(summary),
    '---END_SUMMARY_JSON---',
    '---IDENTITY_JSON---',
    JSON.stringify({ campaignId, runId: `${scenario}-r1`, scenario }),
    '---END_IDENTITY_JSON---',
  ].join('\n');
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ meta: { poolSize: 250, profile: 'typical', workers: 2, gitSha: sha } }),
    'ssm.get-command-invocation': async (args) => {
      const commandId = args[args.indexOf('--command-id') + 1];
      const send = aws.calls.find((call) =>
        call[0] === 'ssm' && call[1] === 'send-command' && call.includes(commandId));
      const script = send
        ? JSON.parse(send[send.indexOf('--parameters') + 1]).commands.join('\n')
        : '';
      const stdout = script.includes('/api/meta')
        ? JSON.stringify({ poolSize: 250, profile: 'typical', workers: 2, gitSha: sha })
        : listing;
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: 'Success',
          StandardOutputContent: stdout,
          StandardErrorContent: '',
          ResponseCode: 0,
        }),
        stderr: '',
      };
    },
  });
  const mismatch = await runWith(['collect', '--scenario', scenario, '--json'], {
    now: () => new Date('2026-10-12T03:10:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: p95Terraform(1, campaignId), stderr: '' }),
      fs: memoryFs(),
    },
    env: {
      CWM_CAMPAIGN_ID: campaignId,
      CWM_SCENARIO: scenario,
      CWM_RUN_ID: `${scenario}-r1`,
      CWM_MEASUREMENT_SHA: other,
    },
  });
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.payload.error.code, 'MEASUREMENT_SHA_MISMATCH');
  assert.match(mismatch.payload.error.message, new RegExp(sha));
  assert.match(mismatch.payload.error.message, new RegExp(other));
});
