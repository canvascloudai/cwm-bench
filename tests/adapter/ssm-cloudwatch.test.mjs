import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  MemoryStream,
  createAwsMock,
  ssmOnlineHandlers,
  terraformOutputFixture,
} from '../helpers.mjs';

async function runWith(argv, options) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(argv, { stdout, stderr, ...options });
  return { code, payload: JSON.parse(stdout.toString()), stdout: stdout.toString() };
}

test('SSM send-command failure is a nonzero JSON error', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ poolSize: 250 }),
    'ssm.send-command': async () => ({
      code: 1,
      stdout: '',
      stderr: 'An error occurred (AccessDenied) when calling SendCommand',
    }),
  });
  const result = await runWith(['run', '--scenario', 'normal', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.ok(
    result.payload.error.code === 'AWS_CLI_FAILED' || result.payload.error.code === 'SSM_SEND_FAILED'
  );
  assert.match(result.payload.error.message, /AccessDenied|SendCommand|SSM/i);
});

test('SSM invocation Failed status is SSM_EXECUTION_FAILED', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ poolSize: 250 }),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Failed',
        StandardOutputContent: '',
        StandardErrorContent: 'k6: command failed',
        StatusDetails: 'Exit 99',
      }),
      stderr: '',
    }),
  });
  const result = await runWith(['run', '--scenario', 'peak', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'SSM_EXECUTION_FAILED');
});

test('CloudWatch collection failure is nonzero and not a fabricated metric', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers(),
    'cloudwatch.get-metric-statistics': async () => ({
      code: 1,
      stdout: '',
      stderr: 'An error occurred (Throttling) when calling GetMetricStatistics',
    }),
  });
  const result = await runWith(['collect', '--scenario', 'normal', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'normal-1' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.ok(
    result.payload.error.code === 'CLOUDWATCH_COLLECT_FAILED' ||
      result.payload.error.code === 'AWS_CLI_FAILED'
  );
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.cloudwatch, undefined);
});

test('collect success reports empty CloudWatch datapoints as unmeasured, not invented', async () => {
  const aws = createAwsMock(ssmOnlineHandlers());
  const result = await runWith(['collect', '--scenario', 'idle', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'idle-1', CWM_CAMPAIGN_ID: 'test-campaign' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.invented, false);
  assert.equal(result.payload.complete, false);
  assert.equal(result.payload.knownGap, false);
  assert.equal(result.payload.cloudwatch.status, 'collected');
  const cpu = result.payload.cloudwatch.metrics['app_cpu_i-app1'];
  assert.equal(cpu.summary.available, false);
  assert.equal(cpu.summary.value, null);
  assert.equal(result.payload.latency.p50Ms, null);
  assert.equal(result.payload.errorCategories.iops_throttle, null);
  assert.ok(result.payload.resolvedAmis.amiId.startsWith('ami-'));
  assert.equal(result.payload.terraformOutputs.generator_instance_id, 'i-generator1');
  const joined = aws.calls.map((args) => args.join(' ')).join('\n');
  assert.match(joined, /AWS\/ApplicationELB.*RequestCount|RequestCount.*AWS\/ApplicationELB/);
  assert.ok(aws.calls.some((args) => args.includes('AWS/ApplicationELB') && args.includes('RequestCount')));
  assert.ok(aws.calls.some((args) => args.includes('HTTPCode_Target_2XX_Count')));
  assert.ok(aws.calls.some((args) => args.includes('HTTPCode_Target_5XX_Count')));
  assert.ok(aws.calls.some((args) => args.includes('HTTPCode_ELB_5XX_Count')));
  assert.ok(
    aws.calls.some((args) => args.includes('TargetResponseTime') && args.includes('--extended-statistics'))
  );
  assert.doesNotMatch(result.stdout, /9\.55/);
  assert.doesNotMatch(result.stdout, /\b2\.00\b/);
});

test('wait-ready fails when generator SSM is offline', async () => {
  let nowMs = 0;
  const aws = createAwsMock({
    'ssm.describe-instance-information': async (args) => {
      const filter = args[args.indexOf('--filters') + 1];
      const online = !filter.includes('i-generator1');
      return {
        code: 0,
        stdout: JSON.stringify({
          InstanceInformationList: online ? [{ PingStatus: 'Online' }] : [{ PingStatus: 'ConnectionLost' }],
        }),
        stderr: '',
      };
    },
  });
  const result = await runWith(['wait-ready', '--json'], {
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => nowMs,
      wait: async (ms) => {
        nowMs += ms;
      },
      readinessTimeoutMs: 20_000,
      readinessPollMs: 10_000,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'READINESS_TIMEOUT');
  assert.match(result.payload.error.message, /generator.*not SSM-reachable/i);
  assert.equal(
    aws.calls.filter((args) => args[0] === 'ssm' && args[1] === 'describe-instance-information')
      .length,
    3
  );
});

test('wait-ready retries bootstrap health failures and succeeds within the deadline', async () => {
  let nowMs = 0;
  let commandSequence = 0;
  const waits = [];
  const handlers = ssmOnlineHandlers();
  const aws = createAwsMock({
    ...handlers,
    'ssm.send-command': async () => {
      commandSequence += 1;
      return {
        code: 0,
        stdout: JSON.stringify({ Command: { CommandId: `cmd-${commandSequence}` } }),
        stderr: '',
      };
    },
    'ssm.get-command-invocation': async (args) => {
      const commandId = args[args.indexOf('--command-id') + 1];
      const firstAttempt = commandId === 'cmd-1';
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: firstAttempt ? 'Failed' : 'Success',
          StandardOutputContent: firstAttempt ? '' : '{"status":"ok"}',
          StandardErrorContent: firstAttempt ? 'curl: target did not become ready' : '',
          ResponseCode: firstAttempt ? 22 : 0,
        }),
        stderr: '',
      };
    },
  });

  const result = await runWith(['wait-ready', '--json'], {
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => nowMs,
      wait: async (ms) => {
        waits.push(ms);
        nowMs += ms;
      },
      readinessTimeoutMs: 30_000,
      readinessPollMs: 10_000,
    },
  });

  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.ready.appHealth, true);
  assert.deepEqual(waits, [10_000]);
  assert.equal(
    aws.calls.filter((args) => args[0] === 'ssm' && args[1] === 'send-command').length,
    4
  );
});
