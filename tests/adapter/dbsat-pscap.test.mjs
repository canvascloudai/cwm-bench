import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  DBSAT_PSCAP_TEST_ID_RE,
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

function pscapOutputs(declared = 65528, testId = 'typical-dbsat-pscap-4x-r1-20261017') {
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

function rdsHandlers({ live = '65528', applyStatus = ['in-sync'], group = 'cwm-bench-typical-dbsat-pscap-4x-r1-20261017' } = {}) {
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

test('pscap test ids are accepted; dbsat-v1 ids unchanged', () => {
  for (const id of ['typical-dbsat-pscap-4x-r1-20261017', 'typical-dbsat-pscap-4x-r2a-20261018',
    'typical-dbsat-pscap-2x-r3-20261019']) {
    assert.match(id, DBSAT_PSCAP_TEST_ID_RE);
    assert.match(id, DBSAT_TEST_ID_RE);
    assert.doesNotMatch(id, DBSAT_V1_TEST_ID_RE);
  }
  for (const id of ['typical-dbsat-2x-r1-20261013', 'typical-dbsat-4x-r2-20261014', 'typical-dbsat-3x-c1-20261015',
    'typical-dbsat-3x-d1-20261013', 'typical-dbsat-2x-r1b-20261016']) {
    assert.match(id, DBSAT_TEST_ID_RE);
    assert.match(id, DBSAT_V1_TEST_ID_RE);
  }
  for (const id of ['typical-dbsat-pscap-4x-c1-20261017', 'typical-dbsat-pscap-4x-d1-20261017',
    'typical-dbsat-pscap-5x-r1-20261017', 'typical-dbsat-pscap-4x-r0-20261017', 'typical-dbsat-pscap-4x-r1',
    'typical-dbsat-2x-r3-20261013', 'typical-dbsat-pscap-r1-20261017']) {
    assert.doesNotMatch(id, DBSAT_TEST_ID_RE);
  }
  assert.equal(dbsatScale('typical-dbsat-pscap-4x-r1-20261017'), '4x');
  assert.equal(dbsatScale('typical-dbsat-3x-r2-20261016'), '3x');
});

test('pscap test id passes the dbsat 4x scenario guard and enforces scale', () => {
  const spec = getScenario('typical-dbsat-4x-300');
  assert.equal(assertP95TestId(spec, 'typical-dbsat-pscap-4x-r1-20261017'), 'typical-dbsat-pscap-4x-r1-20261017');
  assert.throws(() => assertP95TestId(spec, 'typical-dbsat-pscap-3x-r1-20261017'), { code: 'TEST_ID_MISMATCH' });
  assert.throws(() => assertP95TestId(getScenario('typical-p95-2x-300'), 'typical-dbsat-pscap-2x-r1-20261017'),
    { code: 'REUSED_KEY' });
});

test('default wait-ready makes no RDS parameter calls (behaviour unchanged)', async () => {
  const aws = createAwsMock(ssmOnlineHandlers());
  const { code, payload } = await waitReady(aws, terraformOutputFixture());
  assert.equal(code, 0);
  assert.equal(payload.dbParameters, undefined);
  assert.equal(payload.ready.dbParameters, undefined);
  assert.equal(aws.calls.filter((args) => args[0] === 'rds').length, 0);
  // Explicit default declared value is also a no-op.
  const aws2 = createAwsMock(ssmOnlineHandlers());
  const r2 = await waitReady(aws2, terraformOutputFixture({ mysql_max_prepared_stmt_count: { value: 16382 } }));
  assert.equal(r2.code, 0);
  assert.equal(aws2.calls.filter((args) => args[0] === 'rds').length, 0);
});

test('pscap wait-ready verifies live max_prepared_stmt_count = 65528 and waits for in-sync', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ applyStatus: ['applying', 'in-sync'] }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 0, JSON.stringify(payload));
  assert.equal(payload.ready.dbParameters, true);
  assert.deepEqual(
    { declared: payload.dbParameters.declared, live: payload.dbParameters.live, applyStatus: payload.dbParameters.applyStatus },
    { declared: 65528, live: 65528, applyStatus: 'in-sync' },
  );
  assert.equal(aws.calls.filter((args) => args[1] === 'describe-db-instances').length, 2);
});

test('pscap wait-ready fails on a live value mismatch', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '16382' }) });
  const { code, payload } = await waitReady(aws, pscapOutputs());
  assert.equal(code, 1);
  assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
});

test('pscap campaign must declare 65528', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: null }) });
  const { code, payload } = await waitReady(aws, pscapOutputs(16382));
  assert.equal(code, 1);
  assert.equal(payload.error.code, 'DB_PARAMETER_MISMATCH');
  assert.match(payload.error.message, /65528/);
});

test('non-default value on a non-pscap campaign is checked against live (no pscap pin)', async () => {
  const aws = createAwsMock({ ...ssmOnlineHandlers(), ...rdsHandlers({ live: '32000', group: 'cwm-bench-typical-dbsat-4x-d1-20261017' }) });
  const { code, payload } = await waitReady(aws, pscapOutputs(32000, 'typical-dbsat-4x-d1-20261017'));
  assert.equal(code, 0, JSON.stringify(payload));
  assert.equal(payload.dbParameters.live, 32000);
});
