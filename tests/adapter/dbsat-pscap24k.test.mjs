import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  DBSAT_PSCAP_TEST_ID_RE,
  DBSAT_PSCAP16K_TEST_ID_RE,
  DBSAT_PSCAP24K_TEST_ID_RE,
  DBSAT_TEST_ID_RE,
  DBSAT_V1_TEST_ID_RE,
  assertP95TestId,
  dbsatScale,
} from '../../scripts/lib/adapter/ladder.mjs';
import { getScenario } from '../../scripts/lib/adapter/scenarios.mjs';
import { MemoryStream, createAwsMock, ssmOnlineHandlers, terraformOutputFixture } from '../helpers.mjs';

async function waitReady(aws, outputs, env = {}) {
  const stdout = new MemoryStream();
  let now = 0;
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    env,
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: outputs, stderr: '' }),
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 60,
      readinessPollMs: 10,
    },
  });
  return { code, payload: JSON.parse(stdout.toString()) };
}

function pscapOutputs(declared = 24576, testId = 'typical-dbsat-pscap24k-2x-r1-20261027') {
  return terraformOutputFixture({
    mysql_max_prepared_stmt_count: { value: declared },
    db_parameter_group_name: { value: `cwm-bench-${testId}` },
    topology_declaration: {
      value: {
        region: 'us-east-1', alb: 'application', app_count: 2, app_instance_type: 'm5.large',
        app_pool_size: 250, db_instance_class: 'db.r5.large', mysql_max_connections: 500, test_id: testId,
      },
    },
  });
}

function rdsHandlers({ live = '24576', applyStatus = ['in-sync'], group = 'cwm-bench-typical-dbsat-pscap24k-2x-r1-20261027' } = {}) {
  let statusIndex = 0;
  return {
    'rds.describe-db-parameters': async (args) => {
      assert.ok(args.includes('--db-parameter-group-name'));
      return {
        code: 0,
        stdout: JSON.stringify(live == null ? [] : [{ ParameterName: 'max_prepared_stmt_count', ParameterValue: live, Source: 'user' }]),
        stderr: '',
      };
    },
    'rds.describe-db-instances': async (args) => {
      const name = args[args.indexOf('--db-instance-identifier') + 1];
      assert.equal(name, 'cwm-bench-example');
      const status = applyStatus[Math.min(statusIndex, applyStatus.length - 1)];
      statusIndex += 1;
      return {
        code: 0,
        stdout: JSON.stringify([{ DBParameterGroupName: group, ParameterApplyStatus: status }]),
        stderr: '',
      };
    },
  };
}

// typical-dbsat-pscap24k-2x-v1: 24,576 prepared-statement cap holdout (prereg §2, §9).

test('pscap24k ids are accepted on 2x only; other families unchanged', () => {
  for (const id of ['typical-dbsat-pscap24k-2x-r1-20261028', 'typical-dbsat-pscap24k-2x-r2a-20261029']) {
    assert.match(id, DBSAT_PSCAP24K_TEST_ID_RE);
    assert.match(id, DBSAT_TEST_ID_RE);
    assert.doesNotMatch(id, DBSAT_PSCAP_TEST_ID_RE);
    assert.doesNotMatch(id, DBSAT_PSCAP16K_TEST_ID_RE);
    assert.equal(dbsatScale(id), '2x');
  }
  for (const id of ['typical-dbsat-pscap24k-3x-r1-20261028', 'typical-dbsat-pscap24k-4x-r1-20261028',
    'typical-dbsat-pscap24k-2x-c1-20261028', 'typical-dbsat-pscap24k-2x-r0-20261028', 'typical-dbsat-pscap24k-2x-r1']) {
    assert.doesNotMatch(id, DBSAT_TEST_ID_RE);
  }
  assert.doesNotMatch('typical-dbsat-pscap16k-2x-r1-20261027', DBSAT_PSCAP24K_TEST_ID_RE);
  assert.equal(dbsatScale('typical-dbsat-pscap16k-2x-r1-20261027'), '2x');
  assert.equal(dbsatScale('typical-dbsat-pscap-4x-r1-20261017'), '4x');
  assert.equal(dbsatScale('typical-dbsat-3x-r2-20261016'), '3x');
});

test('pscap24k id passes the dbsat 2x scenario guard and enforces scale', () => {
  const spec = getScenario('typical-dbsat-2x-300');
  assert.equal(assertP95TestId(spec, 'typical-dbsat-pscap24k-2x-r1-20261028'), 'typical-dbsat-pscap24k-2x-r1-20261028');
  assert.throws(() => assertP95TestId(getScenario('typical-dbsat-3x-300'), 'typical-dbsat-pscap24k-2x-r1-20261028'),
    { code: 'TEST_ID_MISMATCH' });
});

test('pscap24k wait-ready verifies live 24576', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ applyStatus: ['applying', 'in-sync'] }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 0, JSON.stringify(payload));
  assert.equal(payload.ready.dbParameters, true);
  assert.equal(payload.dbParameters.declared, 24576);
  assert.equal(payload.dbParameters.live, 24576);
  assert.ok(aws.calls.filter((args) => args[0] === 'rds').length > 0);
});

test('pscap24k wait-ready fails on a live 16382 or 65528 left over', async () => {
  for (const live of ['16382', '65528']) {
    const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live }) });
    const { code, payload } = await waitReady(aws, pscapOutputs());
    assert.equal(code, 1);
    assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
  }
});

test('pscap24k wait-ready fails when the parameter group is not in-sync', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ applyStatus: ['pending-reboot'] }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 1);
  assert.ok(payload.error);
});

test('pscap24k campaign must declare 24576', async () => {
  for (const declared of [16382, 65528]) {
    const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: String(declared) }) });
    const { code, payload } = await waitReady(aws, pscapOutputs(declared));
    assert.equal(code, 1);
    assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
    assert.match(payload.error.message, /pscap24k.*24576/);
  }
});

test('pscap16k (16382) and pscap (65528) gates are unchanged', async () => {
  const aws16 = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '16382', group: 'cwm-bench-typical-dbsat-pscap16k-2x-r1-20261027' }) });
  const ok16 = await waitReady(aws16, pscapOutputs(16382, 'typical-dbsat-pscap16k-2x-r1-20261027'));
  assert.equal(ok16.code, 0, JSON.stringify(ok16.payload));
  const aws16bad = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '24576', group: 'cwm-bench-typical-dbsat-pscap16k-2x-r1-20261027' }) });
  const bad16 = await waitReady(aws16bad, pscapOutputs(24576, 'typical-dbsat-pscap16k-2x-r1-20261027'));
  assert.equal(bad16.code, 1);
  assert.match(bad16.payload.error.message, /pscap16k.*16382/);
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: null, group: 'cwm-bench-typical-dbsat-pscap-4x-r1-20261017' }) });
  const { code, payload } = await waitReady(aws, pscapOutputs(24576, 'typical-dbsat-pscap-4x-r1-20261017'));
  assert.equal(code, 1);
  assert.match(payload.error.message, /65528/);
});

// Frozen prediction (prereg §5): the formula is evaluated on measured rung start offsets.
import {
  CAP, HISTORICAL, LOCO_RMSE_MEDIAN, MEDIAN_PATTERN, MODEL, TOLERANCE_POLLS, modeledPolls, predictCrossing,
} from '../../typical/dbsat-pscap24k-2x-v1/predict.mjs';

test('cap and model constants are the frozen ones', () => {
  assert.equal(CAP, 24576);
  assert.deepEqual({ ...MODEL }, {
    betaTime: 29.8120561524, betaRequests: 33.6008348159, betaConnections: 38.9871549291,
    initialPrepared: 928, initialConnections: 20,
  });
  assert.notEqual(CAP, 16382);
  assert.notEqual(CAP, 32764);
  assert.notEqual(CAP, 65528);
});

test('frozen prediction table: crossing lies in the 700 rung under every historical gap pattern', () => {
  const expected = {
    'conn-2x-v1.1 r1': [690, 3819.6, 22924, 26089],
    'conn-2x-v1.1 r2': [690, 3818.9, 22924, 26089],
    'pscap16k-2x-v1 r1b': [525, 4390.9, 23351, 26660],
    'pscap16k-2x-v1 r2': [525, 4371.4, 23339, 26644],
  };
  for (const [name, [s, t, start, end]] of Object.entries(expected)) {
    const offsets = HISTORICAL[name];
    const c = predictCrossing(offsets);
    assert.equal(c.rps, 700, name);
    assert.equal(c.s, s, name);
    assert.ok(Math.abs(c.t - t) < 0.06, `${name} t=${c.t}`);
    const polls = modeledPolls(offsets).filter((p) => p.rps === 700);
    assert.equal(Math.round(polls[0].count), start, name);
    assert.equal(Math.round(polls.at(-1).count), end, name);
    assert.ok(polls[0].count < CAP && polls.at(-1).count > CAP, name);
  }
});

test('median pattern and contiguous reference rows', () => {
  assert.deepEqual([...MEDIAN_PATTERN], [0, 1646.181, 3487.994]);
  const med = predictCrossing(MEDIAN_PATTERN);
  assert.deepEqual({ rps: med.rps, s: med.s }, { rps: 700, s: 615 });
  assert.ok(Math.abs(med.t - 4102.994) < 1e-6);
  const prev = modeledPolls(MEDIAN_PATTERN).find((p) => p.rps === 700 && p.s === 600);
  assert.ok(Math.abs(prev.count - 24555.8) < 0.1 && prev.count < CAP);
  const contiguous = predictCrossing([0, 1200, 2400]);
  assert.deepEqual({ rps: contiguous.rps, s: contiguous.s }, { rps: 700, s: 840 });
  // no earlier-rung crossing in any pattern
  for (const offsets of [...Object.values(HISTORICAL), MEDIAN_PATTERN]) {
    assert.ok(modeledPolls(offsets).filter((p) => p.rps < 700).every((p) => p.count < CAP));
  }
});

test('tolerance N is LOCO RMSE over local growth at the median-pattern crossing', () => {
  const growth = predictCrossing(MEDIAN_PATTERN).growthPerPoll;
  assert.ok(Math.abs(growth - 45.49) < 0.01, String(growth));
  assert.equal(Math.round(LOCO_RMSE_MEDIAN / growth), TOLERANCE_POLLS);
  assert.equal(TOLERANCE_POLLS, 34);
});

test('prereg pins the frozen values used by the prediction tests', () => {
  const doc = readFileSync(new URL('../../typical/dbsat-pscap24k-2x-v1/PREREGISTRATION.md', import.meta.url), 'utf8');
  for (const needle of ['29.8120561524', '33.6008348159', '38.9871549291', '24576', '24,576', 'N = 34 polls',
    'ba432f902ba8c35de670448f4e43fdfce204c2ff', '8747a554126ee34b57898be44a74e579913f570b',
    '300: 130; 500: 279; 700: 491; 900: 500', '1,646.181', '3,487.994']) {
    assert.ok(doc.includes(needle), `prereg is missing ${needle}`);
  }
  assert.ok(!doc.includes('32,764') && !doc.includes('pscap32k'));
});
