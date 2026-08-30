import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { ADAPTER_VERSION } from '../../scripts/lib/adapter/version.mjs';
import { SCENARIO_KEYS } from '../../scripts/lib/adapter/scenarios.mjs';
import { MemoryStream, createAwsMock, ssmOnlineHandlers, terraformOutputFixture } from '../helpers.mjs';

test('wait-ready succeeds when terraform output is empty JSON (init, no apply)', async () => {
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, true);
  assert.equal(payload.provisioned, false);
  assert.equal(payload.adapterVersion, ADAPTER_VERSION);
  assert.ok(payload.supportedScenarios.includes('second-region'));
});

test('wait-ready succeeds with capability JSON when terraform CLI is missing', async () => {
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => ({
        code: 127,
        stdout: '',
        stderr: 'spawn terraform ENOENT',
      }),
    },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, true);
  assert.equal(payload.provisioned, false);
  assert.equal(payload.adapterVersion, ADAPTER_VERSION);
  assert.ok(payload.supportedScenarios.includes('later-day'));
  assert.ok(payload.supportedScenarios.includes('second-region'));
});

test('wait-ready capability JSON includes adapterVersion and every scenario', async () => {
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => ({
        code: 1,
        stdout: '',
        stderr: 'No state file was found; no state',
      }),
    },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, true);
  assert.equal(payload.adapterVersion, ADAPTER_VERSION);
  assert.equal(payload.provisioned, false);
  assert.deepEqual(payload.supportedScenarios, [...SCENARIO_KEYS]);
  for (const key of [
    'idle',
    'normal',
    'peak',
    'burst',
    'pool-bound',
    'app-bound',
    'cpu-only',
    'later-day',
    'second-region',
  ]) {
    assert.ok(payload.supportedScenarios.includes(key), `missing ${key}`);
    const spec = payload.scenarios.find((item) => item.key === key);
    assert.ok(spec, `catalog missing ${key}`);
    assert.equal(spec.aliasOf, null);
  }
  assert.equal(payload.secondRegion, 'us-west-2');
  assert.equal(payload.honesty.laterDayIsAliasOfNormal, false);
  assert.equal(payload.honesty.secondRegionIsAliasOfPrimary, false);
  assert.equal(payload.honesty.inventedMeasurements, false);
  assert.ok(payload.knownGaps.includes('burst'));
});

test('wait-ready success stdout is a single JSON object', async () => {
  const stdout = new MemoryStream();
  await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runTerraform: async () => ({
        code: 1,
        stdout: '',
        stderr: 'No state file was found',
      }),
    },
  });
  const lines = stdout.toString().trim().split('\n');
  assert.equal(lines.length, 1);
  JSON.parse(lines[0]);
});

test('wait-ready after provision reports health and SSM when mocks succeed', async () => {
  const stdout = new MemoryStream();
  const aws = createAwsMock(ssmOnlineHandlers());
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.ok, true);
  assert.equal(payload.provisioned, true);
  assert.equal(payload.ready.terraformOutputs, true);
  assert.equal(payload.ready.generatorSsm, true);
  assert.equal(payload.ready.appHealth, true);
  assert.ok(payload.supportedScenarios.includes('later-day'));
});
