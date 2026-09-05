import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAppMeta, teardownScenario } from '../../scripts/lib/adapter/run.mjs';
import { createAwsMock, ssmOnlineHandlers, terraformOutputFixture } from '../helpers.mjs';

test('run-side app metadata guard retries after a post-reapply connection refusal', async () => {
  let invocationCount = 0;
  let commandCount = 0;
  let now = 0;
  const aws = createAwsMock({
    'ssm.send-command': async () => {
      commandCount += 1;
      return {
        code: 0,
        stdout: JSON.stringify({ Command: { CommandId: `cmd-${commandCount}` } }),
        stderr: '',
      };
    },
    'ssm.get-command-invocation': async () => {
      invocationCount += 1;
      if (invocationCount === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            Status: 'Failed',
            StandardErrorContent: 'curl: (7) Failed to connect to 127.0.0.1 port 8080',
            StatusDetails: 'Exit 7',
          }),
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: 'Success',
          StandardOutputContent: JSON.stringify({ poolSize: 40 }),
          StandardErrorContent: '',
          ResponseCode: 0,
        }),
        stderr: '',
      };
    },
  });

  const meta = await readAppMeta(aws, 'i-app1', 'us-east-1', {
    env: {},
    deps: {
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      appMetaReadinessTimeoutMs: 50,
      appMetaReadinessPollMs: 5,
      ssmWaitMs: 10,
      ssmPollMs: 1,
    },
  });

  assert.deepEqual(meta, { poolSize: 40 });
  assert.equal(invocationCount, 2);
  assert.equal(commandCount, 2);
  assert.equal(now, 5);
});

test('interrupted-run teardown stops the campaign/run identity through SSM', async () => {
  const runAws = createAwsMock(ssmOnlineHandlers());
  const result = await teardownScenario({
    env: {
      CWM_CAMPAIGN_ID: 'campaign-1',
      CWM_RUN_ID: 'run-1',
    },
    deps: {
      runTerraform: async () => ({
        code: 0,
        stdout: terraformOutputFixture(),
        stderr: '',
      }),
      runAws,
      ssmWaitMs: 10,
      ssmPollMs: 1,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.campaignId, 'campaign-1');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.teardown.k6Stopped, true);
  assert.equal(
    runAws.calls.filter((args) => args[0] === 'ssm' && args[1] === 'send-command').length,
    1,
  );
  assert.match(
    JSON.stringify(runAws.calls),
    /campaign-1/,
  );
  assert.match(
    JSON.stringify(runAws.calls),
    /run-1/,
  );
});