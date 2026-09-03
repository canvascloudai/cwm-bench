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
  const result = await runWith(['run', '--scenario', 'cpu-only', '--json'], {
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
  const result = await runWith(['run', '--scenario', 'cpu-only', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'SSM_EXECUTION_FAILED');
});

test('CloudWatch collection failure is nonzero, retry-bounded, and not fabricated', async () => {
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
      wait: async () => {},
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'CLOUDWATCH_PARTIAL');
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.cloudwatch.status, 'partial');
  assert.ok(result.payload.cloudwatch.queryFailures.length > 0);
  assert.ok(result.payload.cloudwatch.retryCounts['app_cpu_i-app1'] >= 0);
  assert.equal(
    aws.calls.filter((args) => args[1] === 'get-metric-statistics').length,
    3 * Object.keys(result.payload.cloudwatch.metrics).length,
  );
});

test('failed SSM run preserves terminal status and remote output in JSON', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ poolSize: 250 }),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Failed',
        StandardOutputContent: 'k6 summary was written before exit',
        StandardErrorContent: 'k6 exited 99',
        ResponseCode: 99,
      }),
      stderr: '',
    }),
  });
  const result = await runWith(['run', '--scenario', 'cpu-only', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'SSM_EXECUTION_FAILED');
  assert.match(result.payload.error.message, /SSM command Failed/);
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
  let now = 0;
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
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 25,
      readinessPollMs: 10,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'READINESS_TIMEOUT');
  assert.match(result.payload.error.message, /generator/i);
});

test('wait-ready fails immediately for terminal SSM API errors', async () => {
  let now = 0;
  const aws = createAwsMock({
    'ssm.describe-instance-information': async () => ({
      code: 1,
      stdout: '',
      stderr: 'An error occurred (AccessDeniedException) when calling DescribeInstanceInformation',
    }),
  });
  const result = await runWith(['wait-ready', '--json'], {
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 25,
      readinessPollMs: 10,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'AWS_CLI_FAILED');
  assert.match(result.payload.error.message, /AccessDenied|DescribeInstanceInformation/);
  assert.equal(aws.calls.filter((args) => args[1] === 'describe-instance-information').length, 1);
});

test('wait-ready does not retry terminal SSM invocation statuses', async () => {
  let now = 0;
  const aws = createAwsMock({
    ...ssmOnlineHandlers(),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Undeliverable',
        StandardErrorContent: 'SSM agent cannot deliver the command',
        StatusDetails: 'Undeliverable',
      }),
      stderr: '',
    }),
  });
  const result = await runWith(['wait-ready', '--json'], {
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      nowMs: () => now,
      wait: async (ms) => { now += ms; },
      readinessTimeoutMs: 25,
      readinessPollMs: 10,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'SSM_EXECUTION_FAILED');
  assert.match(result.payload.error.message, /Undeliverable|cannot deliver/);
  assert.equal(aws.calls.filter((args) => args[1] === 'send-command').length, 1);
});
