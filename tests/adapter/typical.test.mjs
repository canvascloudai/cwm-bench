import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  assertExpectedProfile,
  assertLaterDay,
  assertSecondRegion,
  assertTypicalRegion,
  getScenario,
  listScenarioKeys,
} from '../../scripts/lib/adapter/scenarios.mjs';
import { SECOND_REGION, TYPICAL_REGION } from '../../scripts/lib/adapter/version.mjs';
import { metaFromStdout } from '../../scripts/lib/adapter/ready.mjs';
import {
  APP_TEMPLATE_VARS,
  GENERATOR_TEMPLATE_VARS,
  renderTemplate,
} from '../render-userdata.mjs';
import {
  MemoryStream,
  createAwsMock,
  ssmOnlineHandlers,
  terraformOutputFixture,
} from '../helpers.mjs';

const require = createRequire(import.meta.url);
const { poolSizePerWorker, handleWorkerExit } = require('../../app-typical/src/pool.js');
const {
  TOKEN_EXP,
  TOKEN_IAT,
  TOKEN_KEY,
  signToken,
  tokenForUser,
  verifyToken,
} = require('../../app-typical/src/token.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LEAN_SHA256 = Object.freeze({
  'app/src/server.js': 'b19fe09a4ac4f29b282971fe4d2d6e362c6a076156637ad8d2d0f4586c94b7a9',
  'app/package.json': 'c2003aa81d096e51921fc718c0657a11e64b092555bcc91bc1ae19ad509f9311',
  'app/package-lock.json': '28a3d01a677434c3e81db1c6ce8a617eb8d092177374538748837d6e05a79edf',
  'app/seed/seed.sql': '0dd5e5ba340b885f4fc03af917ea900875ba096bbf44a0709cdcb7b93758235d',
  'load/scenarios.js': '62015feee74f8824b064c7098b27e4a3c01fc2f9dedbfd9f5afa9b67e4245f80',
  'load/diagnostics.js': 'bdfd3f9b6dea70a85cfbf48a2f461c4b3e0cb52b65e0dec071a2b028113aabad',
  'terraform/userdata/generator.sh.tftpl': 'e5d6ca3ee25c7616590837204f224f711da730fdd8cfcd7d3c1c42977dc7480e',
  'terraform/generator.tf': 'd215e9461955ae0b91875ad773721af5ba67c40f3c3aab8997777fdae0349bde',
  'tests/fixtures/common.lean.js': 'abf15ba46f603e2ca2101e86bfc688b30e66be89a00d628fd049ae80d7a4819b',
});

const TYPICAL_KEYS = [
  ['typical-fit-20', 20, 'fit', 'rung'],
  ['typical-fit-100', 100, 'fit', 'rung'],
  ['typical-fit-200', 200, 'fit', 'rung'],
  ['typical-holdout-300', 300, 'holdout', 'holdout'],
  ['typical-saturation-500', 500, 'holdout', 'diagnostic'],
];

function sha256(rel) {
  return createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex');
}

function memoryFs() {
  return {
    readFile: async () => {
      const err = new Error('no state');
      err.code = 'ENOENT';
      throw err;
    },
    writeFile: async () => {},
    mkdir: async () => {},
  };
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
      CWM_CAMPAIGN_ID: 'test-campaign',
      CWM_RUN_ID: `${scenario}-1`,
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
  return { code, payload, stdout: stdout.toString(), stderr: stderr.toString() };
}

function k6Scripts(aws) {
  return aws.calls
    .filter((args) => args[0] === 'ssm' && args[1] === 'send-command')
    .map((send) => JSON.parse(send[send.indexOf('--parameters') + 1]).commands[0]);
}

test('lean files and generator template stay byte-identical to main', () => {
  for (const [rel, digest] of Object.entries(LEAN_SHA256)) {
    assert.equal(sha256(rel), digest, rel);
  }
  const leanCommon = readFileSync(path.join(ROOT, 'tests/fixtures/common.lean.js'), 'utf8');
  const currentCommon = readFileSync(path.join(ROOT, 'load/lib/common.js'), 'utf8');
  assert.ok(currentCommon.startsWith(leanCommon));
  const suffix = currentCommon.slice(leanCommon.length);
  assert.match(suffix, /export const TYPICAL_RPS/);
  assert.match(suffix, /'typical-later-day': 100/);
  assert.match(suffix, /'typical-later-day-300': 300/);
  assert.match(suffix, /'typical-second-region': 100/);
  assert.match(suffix, /'typical-second-region-300': 300/);
  assert.doesNotMatch(leanCommon, /TYPICAL_RPS/);
  assert.doesNotMatch(leanCommon, /typical-later-day/);
  assert.doesNotMatch(leanCommon, /typical-second-region/);
  assert.match(leanCommon, /idle: 10/);
  assert.match(leanCommon, /burst: 1000/);
});

test('rendered lean app user_data matches main and typical only adds profile lines', () => {
  const template = path.join(ROOT, 'terraform/userdata/app.sh.tftpl');
  const golden = readFileSync(path.join(ROOT, 'tests/fixtures/app-userdata-lean.golden'), 'utf8');
  const lean = renderTemplate(template, APP_TEMPLATE_VARS);
  assert.equal(lean, golden);
  assert.doesNotMatch(lean, /APP_PROFILE/);
  assert.doesNotMatch(lean, /app-typical/);
  assert.match(lean, /seed\/seed\.sql/);

  const typical = renderTemplate(template, {
    ...APP_TEMPLATE_VARS,
    app_profile: 'typical',
    app_workers: 2,
  });
  assert.match(typical, /Environment=APP_PROFILE=typical\n/);
  assert.match(typical, /Environment=APP_WORKERS=2\n/);
  assert.match(typical, /\/opt\/cwm-bench-src\/app-typical/);
  assert.match(typical, /seed\/seed-typical\.sql/);
  assert.doesNotMatch(typical, /has no app\/ directory/);
  const normalized = typical
    .replaceAll('app-typical', 'app')
    .replaceAll('seed-typical.sql', 'seed.sql')
    .replace('Environment=APP_PROFILE=typical\nEnvironment=APP_WORKERS=2\n', '');
  assert.equal(normalized, lean);
});

test('generator user_data template render is unchanged for identical inputs', () => {
  const template = path.join(ROOT, 'terraform/userdata/generator.sh.tftpl');
  const golden = readFileSync(path.join(ROOT, 'tests/fixtures/generator-userdata.golden'), 'utf8');
  assert.equal(renderTemplate(template, GENERATOR_TEMPLATE_VARS), golden);

  const leanCommon = readFileSync(path.join(ROOT, 'tests/fixtures/common.lean.js'));
  const currentCommon = readFileSync(path.join(ROOT, 'load/lib/common.js'));
  const leanB64 = leanCommon.toString('base64');
  const currentB64 = currentCommon.toString('base64');
  const withLean = renderTemplate(template, { ...GENERATOR_TEMPLATE_VARS, common_js_b64: leanB64 });
  const withCurrent = renderTemplate(template, { ...GENERATOR_TEMPLATE_VARS, common_js_b64: currentB64 });
  assert.notEqual(withLean, withCurrent);
  assert.equal(withLean.replaceAll(leanB64, 'COMMON'), withCurrent.replaceAll(currentB64, 'COMMON'));
});

test('cluster pool split uses floor and crashed workers are respawned', () => {
  assert.equal(poolSizePerWorker(250, 1), 250);
  assert.equal(poolSizePerWorker(250, 2), 125);
  assert.equal(poolSizePerWorker(250, 8), 31);
  assert.equal(poolSizePerWorker(7, 2), 3);
  const state = { shuttingDown: false, restarts: 0 };
  let forks = 0;
  assert.equal(handleWorkerExit(state, () => { forks += 1; }), 1);
  assert.equal(handleWorkerExit(state, () => { forks += 1; }), 2);
  assert.equal(forks, 2);
  state.shuttingDown = true;
  assert.equal(handleWorkerExit(state, () => { forks += 1; }), 2);
  assert.equal(forks, 2);
});

test('app tokens verify and the load script signs the same user token', () => {
  const token = tokenForUser(1);
  assert.equal(verifyToken(token).sub, 1);
  assert.equal(verifyToken(token).username, 'user1');
  assert.equal(verifyToken(token).iat, TOKEN_IAT);
  assert.equal(verifyToken(token).exp, TOKEN_EXP);
  assert.throws(() => verifyToken(`${token}x`));
  assert.throws(() => verifyToken(signToken({ sub: 1, username: 'user1', iat: 1, exp: 2 })));
  const script = readFileSync(path.join(ROOT, 'load/typical.js'), 'utf8');
  assert.match(script, new RegExp(TOKEN_KEY));
  assert.match(script, /1767225600/);
  assert.match(script, /4102444800/);
  assert.match(script, /Authorization: `Token /);
  assert.match(script, /roll < 0\.59/);
  assert.match(script, /roll < 0\.79/);
  assert.match(script, /roll < 0\.89/);
  assert.match(script, /roll < 0\.99/);
  assert.match(script, /recordErrorClass/);
  assert.match(script, /handleSummary/);
  const seed = readFileSync(path.join(ROOT, 'app-typical/seed/seed-typical.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  assert.doesNotMatch(seed, /\bRAND\s*\(/i);
  assert.doesNotMatch(seed, /\bNOW\s*\(/i);
  assert.doesNotMatch(seed, /\bUUID\s*\(/i);

  const inspected = spawnSync('k6', ['inspect', path.join(ROOT, 'load/typical.js')], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  const selftest = spawnSync('k6', [
    'inspect',
    '-e', 'CWM_TOKEN_SELFTEST=1',
    '-e', `CWM_EXPECTED_TOKEN=${token}`,
    path.join(ROOT, 'load/typical.js'),
  ], { encoding: 'utf8' });
  assert.equal(selftest.status, 0, selftest.stderr);
  for (const key of ['typical-later-day', 'typical-later-day-300', 'typical-second-region', 'typical-second-region-300']) {
    const named = spawnSync('k6', [
      'inspect',
      '-e', `SCENARIO=${key}`,
      path.join(ROOT, 'load/typical.js'),
    ], { encoding: 'utf8' });
    assert.equal(named.status, 0, named.stderr);
  }
});

test('typical scenario catalog has the frozen rungs, pool, workers, and region', () => {
  const keys = listScenarioKeys();
  for (const [key, rps, split, kind] of TYPICAL_KEYS) {
    assert.ok(keys.includes(key), key);
    const spec = getScenario(key);
    assert.equal(spec.rps, rps);
    assert.equal(spec.split, split);
    assert.equal(spec.kind, kind);
    assert.equal(spec.expectedProfile, 'typical');
    assert.equal(spec.expectedWorkers, 2);
    assert.equal(spec.expectedPoolSize, 250);
    assert.equal(spec.requiredRegion, TYPICAL_REGION);
    assert.equal(spec.requiresCompleteCollect, false);
    assert.equal(spec.aliasOf, null);
    assert.equal(spec.workload.script, 'typical.js');
    assert.equal(spec.workload.envValue, key);
  }
  assert.equal(getScenario('typical-saturation-500').completeness, 'optional');
  assert.equal(getScenario('idle').expectedProfile, undefined);
  assert.equal(reportedLean(getScenario('idle')), 'lean');

  const later = getScenario('typical-later-day');
  const later300 = getScenario('typical-later-day-300');
  const second = getScenario('typical-second-region');
  const second300 = getScenario('typical-second-region-300');
  for (const [spec, rps] of [[later, 100], [later300, 300], [second, 100], [second300, 300]]) {
    assert.ok(keys.includes(spec.key));
    assert.equal(spec.rps, rps);
    assert.equal(spec.split, 'holdout');
    assert.equal(spec.kind, 'holdout');
    assert.equal(spec.expectedProfile, 'typical');
    assert.equal(spec.expectedWorkers, 2);
    assert.equal(spec.expectedPoolSize, 250);
    assert.equal(spec.workload.script, 'typical.js');
    assert.equal(spec.workload.envValue, spec.key);
    assert.equal(spec.aliasOf, null);
    assert.notEqual(spec.workload.envValue, 'typical-fit-100');
    assert.notEqual(spec.workload.envValue, 'typical-holdout-300');
    assert.notEqual(spec.workload.script, 'scenarios.js');
  }
  assert.equal(later.requiredRegion, TYPICAL_REGION);
  assert.equal(later.calendarConstraint, 'later-utc-day-than-fit');
  assert.equal(later.regionRole, 'primary');
  assert.equal(later300.requiredRegion, TYPICAL_REGION);
  assert.equal(later300.calendarConstraint, 'later-utc-day-than-fit');
  assert.equal(second.requiredRegion, SECOND_REGION);
  assert.equal(second.regionRole, 'second');
  assert.equal(second.forbiddenRegion, TYPICAL_REGION);
  assert.equal(second300.requiredRegion, SECOND_REGION);
  assert.equal(second300.regionRole, 'second');
  assert.equal(second300.forbiddenRegion, TYPICAL_REGION);
  assert.equal(getScenario('later-day').workload.script, 'scenarios.js');
  assert.equal(getScenario('second-region').workload.script, 'scenarios.js');
  assert.equal(getScenario('later-day').expectedProfile, undefined);
  assert.equal(getScenario('second-region').expectedProfile, undefined);
});

function reportedLean(spec) {
  assert.doesNotThrow(() => assertExpectedProfile(spec, { poolSize: 250 }));
  return 'lean';
}

test('profile mismatch is rejected in both directions before k6', async () => {
  const typicalMeta = { poolSize: 250, profile: 'typical', workers: 2, gitSha: 'abc' };
  const leanAws = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta }));
  const leanOnTypical = await runWith(['run', '--scenario', 'idle', '--json'], {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    statePath: '/tmp/cwm-typical-lean-mismatch.json',
    deps: {
      runAws: leanAws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(leanOnTypical.code, 1);
  assert.equal(leanOnTypical.payload.error.code, 'PROFILE_MISMATCH');
  assert.equal(k6Scripts(leanAws).some((script) => script.includes('k6 run')), false);

  const typicalAws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const typicalOnLean = await runWith(['run', '--scenario', 'typical-fit-100', '--json'], {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    statePath: '/tmp/cwm-typical-on-lean.json',
    deps: {
      runAws: typicalAws,
      runTerraform: async () => ({
        code: 0,
        stdout: terraformOutputFixture({
          topology_declaration: { value: { region: 'us-east-2', test_id: 'typical', app_pool_size: 250 } },
        }),
        stderr: '',
      }),
      fs: memoryFs(),
    },
  });
  assert.equal(typicalOnLean.code, 1);
  assert.equal(typicalOnLean.payload.error.code, 'PROFILE_MISMATCH');
  assert.equal(k6Scripts(typicalAws).some((script) => script.includes('k6 run')), false);
});

test('typical run refuses the wrong region and the wrong worker count without starting k6', async () => {
  const wrongRegion = createAwsMock(ssmOnlineHandlers({
    meta: { poolSize: 250, profile: 'typical', workers: 2 },
  }));
  const regionResult = await runWith(['run', '--scenario', 'typical-holdout-300', '--json'], {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    deps: {
      runAws: wrongRegion,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(regionResult.code, 1);
  assert.equal(regionResult.payload.error.code, 'TYPICAL_REGION_CONSTRAINT');
  assert.equal(wrongRegion.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);

  const wrongWorkers = createAwsMock(ssmOnlineHandlers({
    meta: { poolSize: 250, profile: 'typical', workers: 1 },
  }));
  const workersResult = await runWith(['run', '--scenario', 'typical-fit-20', '--json'], {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    deps: {
      runAws: wrongWorkers,
      runTerraform: async () => ({
        code: 0,
        stdout: terraformOutputFixture({
          topology_declaration: { value: { region: 'us-east-2', test_id: 'typical', app_pool_size: 250 } },
        }),
        stderr: '',
      }),
      fs: memoryFs(),
    },
  });
  assert.equal(workersResult.code, 1);
  assert.equal(workersResult.payload.error.code, 'PROFILE_MISMATCH');
  assert.equal(k6Scripts(wrongWorkers).some((script) => script.includes('k6 run')), false);
  assert.throws(
    () => assertTypicalRegion(getScenario('typical-saturation-500'), 'us-west-2'),
    (err) => err.code === 'TYPICAL_REGION_CONSTRAINT'
  );
  assert.doesNotThrow(() => assertTypicalRegion(getScenario('typical-fit-20'), 'us-east-2'));
});

test('typical run in us-east-2 starts typical.js when profile and pool match', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({
    meta: { poolSize: 250, profile: 'typical', workers: 2, gitSha: 'abc1234', service: 'cwm-bench-app' },
  }));
  const result = await runWith(['run', '--scenario', 'typical-fit-200', '--json'], {
    now: () => new Date('2026-09-02T12:00:00.000Z'),
    statePath: '/tmp/cwm-typical-run.json',
    env: { CWM_WARMUP: '1s', CWM_DURATION: '1s' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({
        code: 0,
        stdout: terraformOutputFixture({
          topology_declaration: { value: { region: 'us-east-2', test_id: 'typical', app_pool_size: 250 } },
        }),
        stderr: '',
      }),
      fs: memoryFs(),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.scenario, 'typical-fit-200');
  assert.equal(result.payload.rps, 200);
  assert.equal(result.payload.split, 'fit');
  assert.equal(result.payload.region, 'us-east-2');
  const script = k6Scripts(aws).find((entry) => entry.includes('k6 run'));
  assert.match(script, /load\/typical\.js/);
  assert.match(script, /SCENARIO='typical-fit-200'/);
});

test('wait-ready reports profile, workers, and gitSha from each app node', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({
    meta: {
      status: 'ok',
      service: 'cwm-bench-app',
      profile: 'typical',
      workers: 2,
      poolSize: 250,
      gitSha: 'deadbeef',
    },
  }));
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(code, 0, stdout.toString());
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.appNodes.length, 2);
  for (const node of payload.appNodes) {
    assert.equal(node.profile, 'typical');
    assert.equal(node.workers, 2);
    assert.equal(node.gitSha, 'deadbeef');
  }
  const parsed = metaFromStdout('{"status":"ok"}\n{"profile":"typical","workers":2,"gitSha":"abc","poolSize":250}');
  assert.equal(parsed.profile, 'typical');
  assert.equal(parsed.gitSha, 'abc');
});

const TYPICAL_FIT_DATE = '2026-09-27';
const DAY_AFTER_TYPICAL_FIT = () => new Date('2026-09-28T00:00:01.000Z');

function typicalMeta() {
  return { poolSize: 250, profile: 'typical', workers: 2, gitSha: 'abc1234', service: 'cwm-bench-app' };
}

function typicalTerraform(region) {
  return terraformOutputFixture({
    topology_declaration: { value: { region, test_id: 'typical-holdout', app_pool_size: 250 } },
  });
}

test('typical-later-day uses the fit-campaign date and is not typical-fit-100', () => {
  const fitDay = new Date('2026-09-27T23:59:59.000Z');
  for (const key of ['typical-later-day', 'typical-later-day-300']) {
    const spec = getScenario(key);
    assert.throws(
      () => assertLaterDay(spec, fitDay, TYPICAL_FIT_DATE),
      (err) => err.code === 'LATER_DAY_CONSTRAINT'
    );
    assert.throws(
      () => assertLaterDay(spec, DAY_AFTER_TYPICAL_FIT(), null),
      (err) => err.code === 'LATER_DAY_CONSTRAINT'
    );
    assert.doesNotThrow(() => assertLaterDay(spec, DAY_AFTER_TYPICAL_FIT(), TYPICAL_FIT_DATE));
  }
  assert.doesNotThrow(() => assertLaterDay(getScenario('typical-fit-100'), fitDay, TYPICAL_FIT_DATE));
  assert.doesNotThrow(() => assertLaterDay(getScenario('typical-holdout-300'), fitDay, TYPICAL_FIT_DATE));
  assert.doesNotThrow(() => assertLaterDay(getScenario('later-day'), DAY_AFTER_TYPICAL_FIT(), '2026-09-01'));
});

test('us-west-2 is accepted only for the typical-second-region keys', () => {
  for (const key of ['typical-second-region', 'typical-second-region-300']) {
    const second = getScenario(key);
    assert.equal(second.rps, key.endsWith('-300') ? 300 : 100);
    assert.doesNotThrow(() => assertSecondRegion(second, 'us-west-2'));
    assert.doesNotThrow(() => assertTypicalRegion(second, 'us-west-2'));
    assert.throws(
      () => assertSecondRegion(second, 'us-east-2'),
      (err) => err.code === 'SECOND_REGION_CONSTRAINT'
    );
    assert.throws(
      () => assertSecondRegion(second, 'us-east-1'),
      (err) => err.code === 'SECOND_REGION_CONSTRAINT'
    );
    assert.throws(
      () => assertSecondRegion(second, null),
      (err) => err.code === 'SECOND_REGION_CONSTRAINT'
    );
    assert.throws(
      () => assertTypicalRegion(second, 'us-east-2'),
      (err) => err.code === 'TYPICAL_REGION_CONSTRAINT'
    );
  }

  for (const key of [
    'typical-fit-20',
    'typical-fit-100',
    'typical-fit-200',
    'typical-holdout-300',
    'typical-saturation-500',
    'typical-later-day',
    'typical-later-day-300',
  ]) {
    assert.doesNotThrow(() => assertSecondRegion(getScenario(key), 'us-west-2'));
    assert.throws(
      () => assertTypicalRegion(getScenario(key), 'us-west-2'),
      (err) => err.code === 'TYPICAL_REGION_CONSTRAINT'
    );
    assert.doesNotThrow(() => assertTypicalRegion(getScenario(key), 'us-east-2'));
  }

  assert.doesNotThrow(() => assertSecondRegion(getScenario('second-region'), 'us-west-2'));
  assert.throws(
    () => assertSecondRegion(getScenario('second-region'), 'us-east-1'),
    (err) => err.code === 'SECOND_REGION_CONSTRAINT'
  );
});

test('run typical-later-day on the fit UTC day does not start k6', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const result = await runWith(['run', '--scenario', 'typical-later-day', '--json'], {
    now: () => new Date('2026-09-27T18:00:00.000Z'),
    env: { CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'LATER_DAY_CONSTRAINT');
  assert.equal(aws.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);
});

test('collect typical-later-day on the fit UTC day fails before AWS', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const result = await runWith(['collect', '--scenario', 'typical-later-day', '--json'], {
    now: () => new Date('2026-09-27T18:00:00.000Z'),
    env: { CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'LATER_DAY_CONSTRAINT');
  assert.equal(aws.calls.length, 0);
});

test('run typical-later-day on a later UTC day in us-east-2 starts typical.js', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const result = await runWith(['run', '--scenario', 'typical-later-day', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    statePath: '/tmp/cwm-typical-later-day.json',
    env: {
      CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE,
      CWM_WARMUP: '1s',
      CWM_DURATION: '1s',
    },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.scenario, 'typical-later-day');
  assert.equal(result.payload.rps, 100);
  assert.equal(result.payload.split, 'holdout');
  assert.equal(result.payload.region, 'us-east-2');
  assert.equal(result.payload.calendarDateUtc, '2026-09-28');
  assert.equal(result.payload.fitCampaignDateUtc, TYPICAL_FIT_DATE);
  const script = k6Scripts(aws).find((entry) => entry.includes('k6 run'));
  assert.match(script, /load\/typical\.js/);
  assert.match(script, /SCENARIO='typical-later-day'/);
  assert.doesNotMatch(script, /SCENARIO='typical-fit-100'/);
  assert.doesNotMatch(script, /load\/scenarios\.js/);
});

test('typical-later-day in us-west-2 and on a lean stack does not start k6', async () => {
  const west = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const westResult = await runWith(['run', '--scenario', 'typical-later-day', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    env: { CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE },
    deps: {
      runAws: west,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(westResult.code, 1);
  assert.equal(westResult.payload.error.code, 'TYPICAL_REGION_CONSTRAINT');
  assert.equal(west.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);

  const lean = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const leanResult = await runWith(['run', '--scenario', 'typical-later-day', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    env: { CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE },
    deps: {
      runAws: lean,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(leanResult.code, 1);
  assert.equal(leanResult.payload.error.code, 'PROFILE_MISMATCH');
  assert.equal(k6Scripts(lean).some((script) => script.includes('k6 run')), false);
});

test('run typical-second-region accepts only us-west-2 and keeps other typical keys locked', async () => {
  const east = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const eastResult = await runWith(['run', '--scenario', 'typical-second-region', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    deps: {
      runAws: east,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(eastResult.code, 1);
  assert.equal(eastResult.payload.error.code, 'SECOND_REGION_CONSTRAINT');
  assert.equal(east.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);

  const other = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const otherResult = await runWith(['run', '--scenario', 'typical-fit-100', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    deps: {
      runAws: other,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(otherResult.code, 1);
  assert.equal(otherResult.payload.error.code, 'TYPICAL_REGION_CONSTRAINT');
  assert.equal(other.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);

  const west = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const westResult = await runWith(['run', '--scenario', 'typical-second-region', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    statePath: '/tmp/cwm-typical-second-region.json',
    env: { CWM_WARMUP: '1s', CWM_DURATION: '1s' },
    deps: {
      runAws: west,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(westResult.code, 0, westResult.stdout);
  assert.equal(westResult.payload.ok, true);
  assert.equal(westResult.payload.scenario, 'typical-second-region');
  assert.equal(westResult.payload.rps, 100);
  assert.equal(westResult.payload.region, 'us-west-2');
  assert.equal(westResult.payload.split, 'holdout');
  const script = k6Scripts(west).find((entry) => entry.includes('k6 run'));
  assert.match(script, /load\/typical\.js/);
  assert.match(script, /SCENARIO='typical-second-region'/);
  assert.doesNotMatch(script, /load\/scenarios\.js/);
});

test('wait-ready lists the typical stability holdouts', async () => {
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    },
  });
  assert.equal(code, 0, stdout.toString());
  const payload = JSON.parse(stdout.toString());
  assert.ok(payload.supportedScenarios.includes('typical-later-day'));
  assert.ok(payload.supportedScenarios.includes('typical-later-day-300'));
  assert.ok(payload.supportedScenarios.includes('typical-second-region'));
  assert.ok(payload.supportedScenarios.includes('typical-second-region-300'));
  const later = payload.scenarios.find((item) => item.key === 'typical-later-day');
  const later300 = payload.scenarios.find((item) => item.key === 'typical-later-day-300');
  const second = payload.scenarios.find((item) => item.key === 'typical-second-region');
  const second300 = payload.scenarios.find((item) => item.key === 'typical-second-region-300');
  assert.equal(later.calendarConstraint, 'later-utc-day-than-fit');
  assert.equal(later.requiredRegion, 'us-east-2');
  assert.equal(later.rps, 100);
  assert.equal(later300.calendarConstraint, 'later-utc-day-than-fit');
  assert.equal(later300.requiredRegion, 'us-east-2');
  assert.equal(later300.rps, 300);
  assert.equal(second.requiredRegion, 'us-west-2');
  assert.equal(second.regionRole, 'second');
  assert.equal(second.rps, 100);
  assert.equal(second300.requiredRegion, 'us-west-2');
  assert.equal(second300.regionRole, 'second');
  assert.equal(second300.rps, 300);
  assert.equal(payload.scenarios.find((item) => item.key === 'typical-fit-100').requiredRegion, 'us-east-2');
  assert.equal(payload.scenarios.find((item) => item.key === 'typical-holdout-300').requiredRegion, 'us-east-2');
});

test('run typical-later-day-300 on a later UTC day in us-east-2 starts typical.js at 300 RPS', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const result = await runWith(['run', '--scenario', 'typical-later-day-300', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    statePath: '/tmp/cwm-typical-later-day-300.json',
    env: {
      CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE,
      CWM_WARMUP: '1s',
      CWM_DURATION: '1s',
    },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.scenario, 'typical-later-day-300');
  assert.equal(result.payload.rps, 300);
  assert.equal(result.payload.split, 'holdout');
  assert.equal(result.payload.region, 'us-east-2');
  assert.equal(result.payload.fitCampaignDateUtc, TYPICAL_FIT_DATE);
  const script = k6Scripts(aws).find((entry) => entry.includes('k6 run'));
  assert.match(script, /load\/typical\.js/);
  assert.match(script, /SCENARIO='typical-later-day-300'/);
  assert.doesNotMatch(script, /SCENARIO='typical-holdout-300'/);

  const west = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const westResult = await runWith(['run', '--scenario', 'typical-later-day-300', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    env: { CWM_FIT_CAMPAIGN_DATE: TYPICAL_FIT_DATE },
    deps: {
      runAws: west,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(westResult.code, 1);
  assert.equal(westResult.payload.error.code, 'TYPICAL_REGION_CONSTRAINT');
  assert.equal(west.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);
});

test('run typical-second-region-300 accepts only us-west-2', async () => {
  const east = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const eastResult = await runWith(['run', '--scenario', 'typical-second-region-300', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    deps: {
      runAws: east,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-east-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(eastResult.code, 1);
  assert.equal(eastResult.payload.error.code, 'SECOND_REGION_CONSTRAINT');
  assert.equal(east.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'), false);

  const locked = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const lockedResult = await runWith(['run', '--scenario', 'typical-holdout-300', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    deps: {
      runAws: locked,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(lockedResult.code, 1);
  assert.equal(lockedResult.payload.error.code, 'TYPICAL_REGION_CONSTRAINT');

  const west = createAwsMock(ssmOnlineHandlers({ meta: typicalMeta() }));
  const westResult = await runWith(['run', '--scenario', 'typical-second-region-300', '--json'], {
    now: DAY_AFTER_TYPICAL_FIT,
    statePath: '/tmp/cwm-typical-second-region-300.json',
    env: { CWM_WARMUP: '1s', CWM_DURATION: '1s' },
    deps: {
      runAws: west,
      runTerraform: async () => ({ code: 0, stdout: typicalTerraform('us-west-2'), stderr: '' }),
      fs: memoryFs(),
    },
  });
  assert.equal(westResult.code, 0, westResult.stdout);
  assert.equal(westResult.payload.scenario, 'typical-second-region-300');
  assert.equal(westResult.payload.rps, 300);
  assert.equal(westResult.payload.region, 'us-west-2');
  const script = k6Scripts(west).find((entry) => entry.includes('k6 run'));
  assert.match(script, /load\/typical\.js/);
  assert.match(script, /SCENARIO='typical-second-region-300'/);
  assert.doesNotMatch(script, /SCENARIO='typical-holdout-300'/);
});
