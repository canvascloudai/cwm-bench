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
  assert.equal(payload.honesty.burstRequiresCompleteCollect, true);
  assert.equal(payload.honesty.burstIsKnownGap, undefined);
  assert.equal(payload.knownGaps.includes('burst'), false);
  assert.deepEqual(payload.requiresCompleteCollect, ['burst', 'cpu-only']);
  const burst = payload.scenarios.find((item) => item.key === 'burst');
  assert.equal(burst.completeness, 'collected');
  assert.equal(burst.requiresCompleteCollect, true);
  assert.equal(burst.knownGap, undefined);
  const cpuOnly = payload.scenarios.find((item) => item.key === 'cpu-only');
  assert.equal(cpuOnly.completeness, 'collected');
  assert.equal(cpuOnly.requiresCompleteCollect, true);
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

test('wait-ready retries normal bootstrap failures until all checks succeed', async () => {
  let now = 0;
  let describeCalls = 0;
  let invocationCalls = 0;
  const aws = createAwsMock({
    'ssm.describe-instance-information': async () => {
      describeCalls += 1;
      return {
        code: 0,
        stdout: JSON.stringify({
          InstanceInformationList: describeCalls === 1
            ? []
            : [{ PingStatus: 'Online', AgentVersion: '3.0.0' }],
        }),
        stderr: '',
      };
    },
    'ssm.send-command': async () => ({
      code: 0,
      stdout: JSON.stringify({ Command: { CommandId: `cmd-${invocationCalls + 1}` } }),
      stderr: '',
    }),
    'ssm.get-command-invocation': async () => {
      invocationCalls += 1;
      if (invocationCalls === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            Status: 'Failed',
            StandardErrorContent: 'curl: connection refused while app is starting',
            StatusDetails: 'Exit 7',
          }),
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: 'Success',
          StandardOutputContent: '{"status":"ok"}',
          StandardErrorContent: '',
          ResponseCode: 0,
        }),
        stderr: '',
      };
    },
  });
  const code = await main(['wait-ready', '--json'], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 100,
      readinessPollMs: 10,
    },
  });
  assert.equal(code, 0);
  assert.equal(describeCalls, 4);
  assert.equal(invocationCalls, 4);
});

test('wait-ready returns bounded diagnostics when bootstrap never completes', async () => {
  let now = 0;
  const aws = createAwsMock({
    'ssm.describe-instance-information': async () => ({
      code: 0,
      stdout: JSON.stringify({ InstanceInformationList: [] }),
      stderr: '',
    }),
  });
  const stdout = new MemoryStream();
  const code = await main(['wait-ready', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 25,
      readinessPollMs: 10,
    },
  });
  assert.equal(code, 1);
  const payload = JSON.parse(stdout.toString());
  assert.equal(payload.error.code, 'READINESS_TIMEOUT');
  assert.match(payload.error.message, /generator SSM|still starting|attempt/);
  assert.match(payload.error.message, /InstanceInformation|generator/i);
});
