import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { ADAPTER_VERSION } from '../../scripts/lib/adapter/version.mjs';
import { collectionWindow } from '../../scripts/lib/adapter/collect.mjs';
import { cloudWatchAlbDimension, cloudWatchTargetGroupDimension } from '../../scripts/lib/adapter/aws.mjs';
import {
  MemoryStream,
  artifactListingStdout,
  collectCompleteHandlers,
  createAwsMock,
  k6SummaryFixture,
  ssmOnlineHandlers,
  terraformOutputFixture,
} from '../helpers.mjs';

async function runWith(argv, options) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(argv, { stdout, stderr, ...options });
  return { code, payload: JSON.parse(stdout.toString()), stdout: stdout.toString(), stderr: stderr.toString() };
}

const memoryFs = {
  readFile: async () => {
    const err = new Error('no state');
    err.code = 'ENOENT';
    throw err;
  },
  writeFile: async () => {},
  mkdir: async () => {},
};

test('adapter version is 1.2.4', () => {
  assert.equal(ADAPTER_VERSION, '1.2.4');
});

test('persisted CloudWatch windows exclude the unstable terminal minute', () => {
  const window = collectionWindow(new Date('2026-09-05T01:56:08.019Z'), {
    CWM_RUN_STARTED_AT: '2026-09-05T01:41:08.019Z',
    CWM_RUN_ENDED_AT: '2026-09-05T01:56:08.019Z',
  }, null);
  assert.equal(window.startTime, '2026-09-05T01:42:00.000Z');
  assert.equal(window.endTime, '2026-09-05T01:55:00.000Z');
  assert.equal(window.source, 'persisted-run');
});

test('ALB and target-group ARNs map to CloudWatch dimensions', () => {
  assert.equal(
    cloudWatchAlbDimension(
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/cwm-bench-example/abc123def456'
    ),
    'app/cwm-bench-example/abc123def456'
  );
  assert.equal(
    cloudWatchTargetGroupDimension(
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/cwm-bench-example/def456abc123'
    ),
    'targetgroup/cwm-bench-example/def456abc123'
  );
});

test('collect burst with empty CloudWatch fails COLLECT_INCOMPLETE', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers(),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Success',
        StandardOutputContent: artifactListingStdout(null, '/opt/cwm-bench/results/raw/test-campaign/burst-1'),
        StandardErrorContent: '',
        ResponseCode: 0,
      }),
      stderr: '',
    }),
  });
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.error.code, 'COLLECT_INCOMPLETE');
  assert.equal(result.payload.complete, false);
  assert.equal(result.payload.knownGap, true);
  assert.equal(result.payload.invented, false);
  assert.ok(result.payload.missing.some((item) => item.startsWith('cloudwatch:')));
  assert.ok(result.payload.missing.includes('k6:summary.json'));
  assert.equal(result.payload.latency.p50Ms, null);
  assert.equal(result.payload.errorCategories.iops_throttle, null);
  assert.doesNotMatch(result.stdout, /9\.55/);
  assert.doesNotMatch(result.stdout, /\b2\.00\b/);
});

test('collect burst with mocked complete CloudWatch and k6 summary succeeds', async () => {
  const aws = createAwsMock(collectCompleteHandlers());
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.complete, true);
  assert.equal(result.payload.knownGap, false);
  assert.equal(result.payload.invented, false);
  assert.deepEqual(result.payload.missing, []);
  assert.equal(result.payload.latency.source, 'k6');
  assert.equal(result.payload.latency.p50Ms, 45);
  assert.equal(result.payload.latency.p95Ms, 120);
  assert.equal(result.payload.latency.p99Ms, 300);
  assert.equal(result.payload.albLatency.source, 'alb');
  assert.equal(result.payload.albLatency.p50Ms, 40);
  assert.equal(result.payload.albLatency.p95Ms, 120);
  assert.equal(result.payload.albLatency.p99Ms, 300);
  assert.equal(result.payload.errorCategories.db_timeout, 3);
  assert.equal(result.payload.errorCategories.cpu_overload, 0);
  assert.equal(result.payload.errorCategories.iops_throttle, 1);
  assert.equal(result.payload.iopsThrottle.burstBalanceHitZero, true);
  assert.equal(result.payload.burstBalanceMin.rds, 0);
  assert.equal(result.payload.databaseConnections.max, 120);
  assert.equal(result.payload.databaseConnections.saturation, 'below_cap');
  assert.ok(result.payload.perNode.some((node) => node.role === 'app' && node.cpuAvgPct === 35.5));
  assert.equal(typeof result.payload.goodputRps, 'number');
  assert.doesNotMatch(result.stdout, /9\.55/);
  const joined = aws.calls.map((args) => args.join(' ')).join('\n');
  assert.match(joined, /AWS\/ApplicationELB/);
  assert.ok(aws.calls.some((args) => args.includes('--extended-statistics') && args.includes('p50')));
});

test('collect burst with complete CloudWatch but missing k6 summary fails', async () => {
  const aws = createAwsMock({
    ...collectCompleteHandlers(),
    'ssm.get-command-invocation': async () => ({
      code: 0,
      stdout: JSON.stringify({
        Status: 'Success',
        StandardOutputContent: 'ARTIFACT_DIR_MISSING\n',
        StandardErrorContent: '',
        ResponseCode: 0,
      }),
      stderr: '',
    }),
  });
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'COLLECT_INCOMPLETE');
  assert.ok(result.payload.missing.includes('k6:summary.json'));
  assert.equal(result.payload.complete, false);
  assert.equal(result.payload.knownGap, true);
});

test('collect accepts the explicit run identity after a successful run', async () => {
  const stored = { body: null };
  const runAws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const runResult = await runWith(['run', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T08:00:00.000Z'),
    statePath: '/tmp/cwm-adapter-state-lastrun.json',
    env: { CWM_CAMPAIGN_ID: 'persisted-campaign', CWM_RUN_ID: 'burst-1', CWM_WARMUP: '1s', CWM_DURATION: '1s' },
    deps: {
      runAws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: {
        readFile: async () => {
          if (!stored.body) {
            const err = new Error('no state');
            err.code = 'ENOENT';
            throw err;
          }
          return stored.body;
        },
        writeFile: async (_path, body) => {
          stored.body = body;
        },
        mkdir: async () => {},
      },
    },
  });
  assert.equal(runResult.code, 0, runResult.stdout);
  assert.ok(runResult.payload.runId);
  const persisted = JSON.parse(stored.body);
  assert.equal(persisted.lastRun.scenario, 'burst');
  assert.equal(persisted.lastRun.runId, runResult.payload.runId);
  assert.equal(persisted.lastRun.campaignId, 'persisted-campaign');

  const collectAws = createAwsMock(
    collectCompleteHandlers({
      dir: `/opt/cwm-bench/results/raw/persisted-campaign/${runResult.payload.runId}`,
    })
  );
  const collectResult = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T08:20:00.000Z'),
    statePath: '/tmp/cwm-adapter-state-lastrun.json',
    env: { CWM_CAMPAIGN_ID: 'persisted-campaign', CWM_RUN_ID: 'burst-1', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: collectAws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: {
        readFile: async () => stored.body,
        writeFile: async (_path, body) => {
          stored.body = body;
        },
        mkdir: async () => {},
      },
    },
  });
  assert.equal(collectResult.code, 0, collectResult.stdout);
  assert.equal(collectResult.payload.runId, runResult.payload.runId);
  assert.equal(collectResult.payload.runIdSource, 'env');
  assert.equal(collectResult.payload.complete, true);
  const artifactSend = collectAws.calls.find((args) => args[0] === 'ssm' && args[1] === 'send-command');
  const params = JSON.parse(artifactSend[artifactSend.indexOf('--parameters') + 1]);
  assert.match(params.commands[0], new RegExp(runResult.payload.runId));
});

test('collect burst does not copy public CWM 2%/9.55% cells even when k6 errors exist', async () => {
  const summary = k6SummaryFixture();
  const aws = createAwsMock(collectCompleteHandlers({ summary, rdsBurstMin: 12 }));
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.errorCategories.iops_throttle, 0);
  assert.equal(result.payload.burstBalanceMin.rds, 12);
  assert.doesNotMatch(result.stdout, /9\.55/);
  assert.doesNotMatch(result.stdout, /980/);
  assert.doesNotMatch(result.stdout, /905/);
});

test('collect rejects a complete artifact envelope with mismatched identity', async () => {
  const aws = createAwsMock(collectCompleteHandlers({
    identity: {
      campaignId: 'test-campaign',
      runId: 'stale-run',
      scenario: 'burst',
    },
  }));
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign', CWM_SCENARIO: 'burst' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.complete, false);
  assert.ok(result.payload.missing.includes('artifacts:identity.json'));
  assert.equal(result.payload.artifacts.identityPresent, true);
  assert.equal(result.payload.artifacts.identityMatches, false);
});
