import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { ADAPTER_VERSION } from '../../scripts/lib/adapter/version.mjs';
import { cloudWatchAlbDimension, cloudWatchTargetGroupDimension } from '../../scripts/lib/adapter/aws.mjs';
import {
  MemoryStream,
  collectCompleteHandlers,
  createAwsMock,
  k6SummaryFixture,
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

function cleanK6SummaryFixture() {
  const summary = k6SummaryFixture();
  summary.metrics = Object.fromEntries(
    Object.entries(summary.metrics).filter(([name]) => !name.startsWith('errors_by_class')),
  );
  summary.metrics.http_req_failed = {
    type: 'rate',
    values: { rate: 0, passes: 15000, fails: 0 },
  };
  return summary;
}

test('adapter version is 1.2.0', () => {
  assert.equal(ADAPTER_VERSION, '1.2.0');
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
  const aws = createAwsMock(ssmOnlineHandlers());
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign' },
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
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign' },
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

test('collect accepts a clean zero-error run with sparse k6 and ALB 5xx telemetry', async () => {
  const cleanSummary = cleanK6SummaryFixture();
  const aws = createAwsMock(
    collectCompleteHandlers({
      summary: cleanSummary,
      dir: '/opt/cwm-bench/results/raw/test-campaign/burst-clean',
      omitTarget5xx: true,
      omitElb5xx: true,
    }),
  );
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-clean', CWM_CAMPAIGN_ID: 'test-campaign' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });

  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.complete, true);
  assert.deepEqual(result.payload.missing, []);
  assert.deepEqual(result.payload.errorCategories, {
    db_timeout: 0,
    too_many_connections: 0,
    queue_full: 0,
    cpu_overload: 0,
    internal: 0,
    iops_throttle: 1,
    unclassified: 0,
  });
  assert.deepEqual(result.payload.cloudwatch.metrics.alb_http_target_5xx.datapoints, []);
  assert.deepEqual(result.payload.cloudwatch.metrics.alb_http_elb_5xx.datapoints, []);
  assert.equal(result.payload.cloudwatch.metrics.alb_http_target_5xx.summary.available, false);
  assert.equal(result.payload.cloudwatch.metrics.alb_http_elb_5xx.summary.available, false);
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
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign' },
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

test('collect rejects ALB 5xx datapoints that contradict a clean k6 summary', async () => {
  const cleanSummary = cleanK6SummaryFixture();
  const aws = createAwsMock(
    collectCompleteHandlers({
      summary: cleanSummary,
    }),
  );
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-contradictory', CWM_CAMPAIGN_ID: 'test-campaign' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });

  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.payload.complete, false);
  assert.ok(result.payload.missing.includes('cloudwatch:alb_http_5xx:contradictory'));
  assert.equal(result.payload.cloudwatch.metrics.alb_http_target_5xx.datapoints[0].sum, 4);
  assert.equal(result.payload.cloudwatch.metrics.alb_http_elb_5xx.datapoints[0].sum, 4);
});

test('collect excludes pre-run ELB 5xx from a clean persisted run window', async () => {
  const cleanSummary = cleanK6SummaryFixture();
  const handlers = collectCompleteHandlers({
    summary: cleanSummary,
    dir: '/opt/cwm-bench/results/raw/test-campaign/burst-clean',
    timestamp: '2026-09-01T00:12:00Z',
    omitTarget5xx: true,
    omitElb5xx: true,
  });
  handlers['cloudwatch.get-metric-statistics'] = async (args) => {
    const metric = args[args.indexOf('--metric-name') + 1];
    if (metric === 'HTTPCode_ELB_5XX_Count') {
      return {
        code: 0,
        stdout: JSON.stringify({
          Label: metric,
          Datapoints: [
            { Timestamp: '2026-09-01T00:09:00Z', Sum: 1, Unit: 'Count' },
          ],
        }),
        stderr: '',
      };
    }
    return collectCompleteHandlers({
      summary: cleanSummary,
      timestamp: '2026-09-01T00:12:00Z',
      omitTarget5xx: true,
      omitElb5xx: true,
    })['cloudwatch.get-metric-statistics'](args);
  };
  const aws = createAwsMock(handlers);
  const stored = JSON.stringify({
    lastRuns: {
      burst: {
        scenario: 'burst',
        runId: 'burst-clean',
        campaignId: 'test-campaign',
        startedAt: '2026-09-01T00:10:20.000Z',
        endedAt: '2026-09-01T00:25:40.000Z',
      },
    },
  });
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:30:00.000Z'),
    env: {
      CWM_RUN_ID: 'burst-clean',
      CWM_CAMPAIGN_ID: 'test-campaign',
      CWM_RUN_STARTED_AT: '2026-09-01T00:10:20.000Z',
      CWM_RUN_ENDED_AT: '2026-09-01T00:25:40.000Z',
    },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: { ...memoryFs, readFile: async () => stored },
    },
  });

  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.complete, true);
  assert.deepEqual(result.payload.missing, []);
  assert.deepEqual(result.payload.cloudwatch.metrics.alb_http_elb_5xx.datapoints, []);
  assert.equal(result.payload.cloudwatch.window.source, 'persisted-run');
  assert.equal(result.payload.cloudwatch.window.startTime, '2026-09-01T00:11:00.000Z');
  assert.equal(result.payload.cloudwatch.window.endTime, '2026-09-01T00:25:00.000Z');
  const metricCall = aws.calls.find(
    (args) => args[0] === 'cloudwatch' && args[1] === 'get-metric-statistics',
  );
  assert.equal(metricCall[metricCall.indexOf('--start-time') + 1], '2026-09-01T00:11:00.000Z');
  assert.equal(metricCall[metricCall.indexOf('--end-time') + 1], '2026-09-01T00:25:00.000Z');
});

test('collect rejects explicit zero error counters that contradict a nonzero k6 failure rate', async () => {
  const summary = cleanK6SummaryFixture();
  summary.metrics.errors_by_class = {
    type: 'counter',
    values: { count: 0, rate: 0 },
  };
  summary.metrics.http_req_failed = {
    type: 'rate',
    values: { rate: 0.01, passes: 150, fails: 14850 },
  };
  const aws = createAwsMock(collectCompleteHandlers({ summary, alb5xxCount: 0 }));
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-k6-contradictory', CWM_CAMPAIGN_ID: 'test-campaign' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: memoryFs,
    },
  });

  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.payload.complete, false);
  assert.ok(result.payload.missing.includes('k6:errors_by_class:contradictory'));
});

test('collect refuses to reuse a persisted run when CWM_RUN_ID is unset', async () => {
  const stored = { body: null };
  const runAws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const runResult = await runWith(['run', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T08:00:00.000Z'),
    statePath: '/tmp/cwm-adapter-state-lastrun.json',
    env: { CWM_CAMPAIGN_ID: 'persisted-campaign', CWM_WARMUP: '1s', CWM_DURATION: '1s' },
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
  const stdout = new MemoryStream();
  const collectCode = await main(['collect', '--scenario', 'burst', '--json'], {
    stdout,
    stderr: new MemoryStream(),
    now: () => new Date('2026-09-01T08:20:00.000Z'),
    statePath: '/tmp/cwm-adapter-state-lastrun.json',
    env: { CWM_CAMPAIGN_ID: 'persisted-campaign', CWM_SCENARIO: 'burst' },
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
  const collectPayload = JSON.parse(stdout.toString());
  assert.equal(collectCode, 1);
  assert.equal(collectPayload.error.code, 'RUN_IDENTITY_MISSING');
  assert.equal(collectPayload.campaignId, 'persisted-campaign');
  assert.equal(collectPayload.runId, null);
  assert.equal(collectPayload.scenario, 'burst');
  assert.equal(collectAws.calls.length, 0);
});

test('collect burst does not copy public CWM 2%/9.55% cells even when k6 errors exist', async () => {
  const summary = k6SummaryFixture();
  const aws = createAwsMock(collectCompleteHandlers({ summary, rdsBurstMin: 12 }));
  const result = await runWith(['collect', '--scenario', 'burst', '--json'], {
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    env: { CWM_RUN_ID: 'burst-1', CWM_CAMPAIGN_ID: 'test-campaign' },
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

for (const scenario of [
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
  test(`collect ${scenario} returns complete evidence for its exact run identity`, async () => {
    const campaignId = 'matrix-campaign';
    const runId = `${scenario}-measurement`;
    const region = scenario === 'second-region' ? 'us-west-2' : 'us-east-1';
    const appPoolSize = scenario === 'app-bound' ? 40 : 250;
    const dir = `/opt/cwm-bench/results/raw/${campaignId}/${runId}`;
    const aws = createAwsMock(collectCompleteHandlers({
      dir,
      identity: { campaignId, runId, scenario },
    }));
    const result = await runWith(['collect', '--scenario', scenario, '--json'], {
      now: () => new Date('2026-09-02T12:00:00.000Z'),
      env: {
        CWM_CAMPAIGN_ID: campaignId,
        CWM_RUN_ID: runId,
        CWM_FIT_CAMPAIGN_DATE: '2026-09-01',
      },
      deps: {
        runAws: aws,
        runTerraform: async () => ({
          code: 0,
          stdout: terraformOutputFixture({
            topology_declaration: {
              value: {
                region,
                test_id: campaignId,
                app_pool_size: appPoolSize,
                mysql_max_connections: 500,
              },
            },
          }),
          stderr: '',
        }),
        fs: memoryFs,
      },
    });

    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.payload.campaignId, campaignId);
    assert.equal(result.payload.runId, runId);
    assert.equal(result.payload.scenario, scenario);
    assert.equal(result.payload.complete, true);
    assert.equal(result.payload.artifacts.identityMatches, true);
    assert.equal(result.payload.perNode.length, 4);
    assert.ok(result.payload.perNode.every((node) => node.cpuAvgPct != null));
  });
}

test('run and collect reject missing, malformed, and mismatched worker identity', async () => {
  const cases = [
    {
      argv: ['run', '--scenario', 'idle', '--json'],
      env: { CWM_RUN_ID: 'run-1', CWM_SCENARIO: 'idle' },
      code: 'RUN_IDENTITY_MISSING',
    },
    {
      argv: ['collect', '--scenario', 'idle', '--json'],
      env: { CWM_CAMPAIGN_ID: 'campaign', CWM_RUN_ID: '../stale', CWM_SCENARIO: 'idle' },
      code: 'RUN_IDENTITY_INVALID',
    },
    {
      argv: ['collect', '--scenario', 'app-bound', '--json'],
      env: { CWM_CAMPAIGN_ID: 'campaign', CWM_RUN_ID: 'run-1', CWM_SCENARIO: 'normal' },
      code: 'RUN_IDENTITY_MISMATCH',
    },
  ];

  for (const entry of cases) {
    const stdout = new MemoryStream();
    const code = await main(entry.argv, {
      stdout,
      stderr: new MemoryStream(),
      env: entry.env,
      deps: {},
    });
    const payload = JSON.parse(stdout.toString());
    assert.equal(code, 1);
    assert.equal(payload.error.code, entry.code);
    assert.equal(payload.campaignId, entry.env.CWM_CAMPAIGN_ID || null);
    assert.equal(payload.runId, entry.env.CWM_RUN_ID || null);
    assert.equal(payload.scenario, entry.env.CWM_SCENARIO);
  }
});

test('collect rejects a complete artifact envelope for a different scenario or run', async () => {
  const aws = createAwsMock(collectCompleteHandlers({
    identity: {
      campaignId: 'test-campaign',
      runId: 'normal-stale',
      scenario: 'normal',
    },
  }));
  const result = await runWith(['collect', '--scenario', 'app-bound', '--json'], {
    env: {
      CWM_RUN_ID: 'app-bound-current',
    },
    deps: {
      runAws: aws,
      runTerraform: async () => ({
        code: 0,
        stdout: terraformOutputFixture({
          topology_declaration: {
            value: {
              region: 'us-east-1',
              test_id: 'test-campaign',
              app_pool_size: 40,
              mysql_max_connections: 500,
            },
          },
        }),
        stderr: '',
      }),
      fs: memoryFs,
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.payload.complete, false);
  assert.ok(result.payload.missing.includes('artifacts:identity.json'));
  assert.equal(result.payload.artifacts.identityMatches, false);
});
