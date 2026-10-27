import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  DBSAT_PSCAP_TEST_ID_RE,
  DBSAT_PSCAP16K_TEST_ID_RE,
  DBSAT_PSCAP23K_TEST_ID_RE,
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

function pscapOutputs(declared = 23552, testId = 'typical-dbsat-pscap23k-2x-r1-20261027') {
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

function rdsHandlers({ live = '23552', applyStatus = ['in-sync'], group = 'cwm-bench-typical-dbsat-pscap23k-2x-r1-20261027' } = {}) {
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

// typical-dbsat-pscap23k-2x-v1: 23,552 prepared-statement cap holdout (prereg §2, §9).

test('pscap23k ids are accepted on 2x only; other families unchanged', () => {
  for (const id of ['typical-dbsat-pscap23k-2x-r1-20261028', 'typical-dbsat-pscap23k-2x-r2a-20261029']) {
    assert.match(id, DBSAT_PSCAP23K_TEST_ID_RE);
    assert.match(id, DBSAT_TEST_ID_RE);
    assert.doesNotMatch(id, DBSAT_PSCAP_TEST_ID_RE);
    assert.doesNotMatch(id, DBSAT_PSCAP16K_TEST_ID_RE);
    assert.equal(dbsatScale(id), '2x');
  }
  for (const id of ['typical-dbsat-pscap23k-3x-r1-20261028', 'typical-dbsat-pscap23k-4x-r1-20261028',
    'typical-dbsat-pscap23k-2x-c1-20261028', 'typical-dbsat-pscap23k-2x-r0-20261028', 'typical-dbsat-pscap23k-2x-r1']) {
    assert.doesNotMatch(id, DBSAT_TEST_ID_RE);
  }
  assert.doesNotMatch('typical-dbsat-pscap16k-2x-r1-20261027', DBSAT_PSCAP23K_TEST_ID_RE);
  assert.equal(dbsatScale('typical-dbsat-pscap16k-2x-r1-20261027'), '2x');
  assert.equal(dbsatScale('typical-dbsat-pscap-4x-r1-20261017'), '4x');
  assert.equal(dbsatScale('typical-dbsat-3x-r2-20261016'), '3x');
});

test('pscap23k id passes the dbsat 2x scenario guard and enforces scale', () => {
  const spec = getScenario('typical-dbsat-2x-300');
  assert.equal(assertP95TestId(spec, 'typical-dbsat-pscap23k-2x-r1-20261028'), 'typical-dbsat-pscap23k-2x-r1-20261028');
  assert.throws(() => assertP95TestId(getScenario('typical-dbsat-3x-300'), 'typical-dbsat-pscap23k-2x-r1-20261028'),
    { code: 'TEST_ID_MISMATCH' });
});

test('pscap23k wait-ready verifies live 23552', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ applyStatus: ['applying', 'in-sync'] }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 0, JSON.stringify(payload));
  assert.equal(payload.ready.dbParameters, true);
  assert.equal(payload.dbParameters.declared, 23552);
  assert.equal(payload.dbParameters.live, 23552);
  assert.ok(aws.calls.filter((args) => args[0] === 'rds').length > 0);
});

test('pscap23k wait-ready fails on a live 16382 or 65528 left over', async () => {
  for (const live of ['16382', '65528']) {
    const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live }) });
    const { code, payload } = await waitReady(aws, pscapOutputs());
    assert.equal(code, 1);
    assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
  }
});

test('pscap23k wait-ready fails when the parameter group is not in-sync', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ applyStatus: ['pending-reboot'] }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 1);
  assert.ok(payload.error);
});

test('pscap23k campaign must declare 23552', async () => {
  for (const declared of [16382, 65528]) {
    const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: String(declared) }) });
    const { code, payload } = await waitReady(aws, pscapOutputs(declared));
    assert.equal(code, 1);
    assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
    assert.match(payload.error.message, /pscap23k.*23552/);
  }
});

test('pscap16k (16382) and pscap (65528) gates are unchanged', async () => {
  const aws16 = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '16382', group: 'cwm-bench-typical-dbsat-pscap16k-2x-r1-20261027' }) });
  const ok16 = await waitReady(aws16, pscapOutputs(16382, 'typical-dbsat-pscap16k-2x-r1-20261027'));
  assert.equal(ok16.code, 0, JSON.stringify(ok16.payload));
  const aws16bad = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '23552', group: 'cwm-bench-typical-dbsat-pscap16k-2x-r1-20261027' }) });
  const bad16 = await waitReady(aws16bad, pscapOutputs(23552, 'typical-dbsat-pscap16k-2x-r1-20261027'));
  assert.equal(bad16.code, 1);
  assert.match(bad16.payload.error.message, /pscap16k.*16382/);
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: null, group: 'cwm-bench-typical-dbsat-pscap-4x-r1-20261017' }) });
  const { code, payload } = await waitReady(aws, pscapOutputs(23552, 'typical-dbsat-pscap-4x-r1-20261017'));
  assert.equal(code, 1);
  assert.match(payload.error.message, /65528/);
});
