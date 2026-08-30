import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import {
  assertLaterDay,
  assertSecondRegion,
  getScenario,
  listScenarioKeys,
} from '../../scripts/lib/adapter/scenarios.mjs';
import { buildK6Command } from '../../scripts/lib/adapter/run.mjs';
import {
  MemoryStream,
  createAwsMock,
  ssmOnlineHandlers,
  terraformOutputFixture,
} from '../helpers.mjs';

function laterDayNow() {
  return new Date('2026-09-02T12:00:00.000Z');
}

test('every listed scenario has distinct setup constraints and its own k6 key', () => {
  const keys = listScenarioKeys();
  const envValues = new Set();
  for (const key of keys) {
    const spec = getScenario(key);
    assert.equal(spec.key, key);
    assert.equal(spec.aliasOf, null);
    assert.ok(spec.workload.envValue);
    envValues.add(`${spec.workload.script}:${spec.workload.envName}=${spec.workload.envValue}`);
    const remote = buildK6Command(spec, {
      campaignId: 'c1',
      runId: 'r1',
      warmup: '5m',
      duration: '15m',
    });
    assert.match(remote, new RegExp(`${spec.workload.envName}='${spec.workload.envValue}'`));
    if (key !== 'normal') {
      assert.doesNotMatch(remote, /SCENARIO='normal'/);
    }
  }
  assert.equal(envValues.size, keys.length);
  const later = getScenario('later-day');
  const second = getScenario('second-region');
  const normal = getScenario('normal');
  assert.notEqual(later.workload.envValue, normal.workload.envValue);
  assert.notEqual(second.workload.envValue, normal.workload.envValue);
  assert.equal(later.calendarConstraint, 'later-utc-day-than-fit');
  assert.equal(second.requiredRegion, 'us-west-2');
  assert.equal(later.split, 'holdout');
  assert.equal(second.split, 'holdout');
  const burst = getScenario('burst');
  assert.equal(burst.completeness, 'collected');
  assert.equal(burst.requiresCompleteCollect, true);
  assert.equal(burst.knownGap, undefined);
});

test('later-day is not an alias of normal on the same UTC day', () => {
  const spec = getScenario('later-day');
  assert.throws(
    () => assertLaterDay(spec, new Date('2026-09-01T23:00:00.000Z'), '2026-09-01'),
    (err) => err.code === 'LATER_DAY_CONSTRAINT'
  );
  assert.doesNotThrow(() =>
    assertLaterDay(spec, new Date('2026-09-02T00:00:01.000Z'), '2026-09-01')
  );
});

test('later-day fails without a fit campaign date (no silent normal run)', () => {
  assert.throws(
    () => assertLaterDay(getScenario('later-day'), new Date(), null),
    (err) => err.code === 'LATER_DAY_CONSTRAINT'
  );
});

test('second-region rejects us-east-1 and requires us-west-2', () => {
  const spec = getScenario('second-region');
  assert.throws(() => assertSecondRegion(spec, 'us-east-1'), (err) => err.code === 'SECOND_REGION_CONSTRAINT');
  assert.throws(() => assertSecondRegion(spec, null), (err) => err.code === 'SECOND_REGION_CONSTRAINT');
  assert.throws(() => assertSecondRegion(spec, 'eu-west-1'), (err) => err.code === 'SECOND_REGION_CONSTRAINT');
  assert.doesNotThrow(() => assertSecondRegion(spec, 'us-west-2'));
});

function k6ScriptFrom(aws) {
  const sends = aws.calls.filter((args) => args[0] === 'ssm' && args[1] === 'send-command');
  for (const send of sends) {
    const params = JSON.parse(send[send.indexOf('--parameters') + 1]);
    const script = params.commands[0];
    if (script.includes('k6 run')) return script;
  }
  throw new Error('no k6 SSM send-command was issued');
}

async function runWith(argv, options) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const code = await main(argv, { stdout, stderr, ...options });
  let payload = null;
  try {
    payload = JSON.parse(stdout.toString());
  } catch {
    payload = { raw: stdout.toString() };
  }
  return { code, payload, stdout: stdout.toString(), stderr: stderr.toString() };
}

test('run later-day on the same day fails and does not send k6', async () => {
  const aws = createAwsMock(ssmOnlineHandlers());
  const result = await runWith(['run', '--scenario', 'later-day', '--json'], {
    now: () => new Date('2026-09-01T15:00:00.000Z'),
    env: { CWM_FIT_CAMPAIGN_DATE: '2026-09-01' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'LATER_DAY_CONSTRAINT');
  assert.equal(
    aws.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'),
    false
  );
});

test('run later-day on a later UTC day executes SCENARIO=later-day', async () => {
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ poolSize: 250 }),
  });
  const result = await runWith(['run', '--scenario', 'later-day', '--json'], {
    now: laterDayNow,
    env: {
      CWM_FIT_CAMPAIGN_DATE: '2026-09-01',
      CWM_CAMPAIGN_ID: 'fit-then-holdout',
      CWM_RUN_ID: 'later-day-1',
      CWM_WARMUP: '1s',
      CWM_DURATION: '1s',
    },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.ok, true);
  assert.equal(result.payload.scenario, 'later-day');
  assert.equal(result.payload.aliasOf, null);
  assert.equal(result.payload.split, 'holdout');
  assert.equal(result.payload.calendarDateUtc, '2026-09-02');
  assert.equal(result.payload.fitCampaignDateUtc, '2026-09-01');
  const script = k6ScriptFrom(aws);
  assert.match(script, /SCENARIO='later-day'/);
  assert.doesNotMatch(script, /SCENARIO='normal'/);
});

test('run second-region against us-east-1 fails and does not send k6', async () => {
  const aws = createAwsMock(ssmOnlineHandlers());
  const result = await runWith(['run', '--scenario', 'second-region', '--json'], {
    now: laterDayNow,
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'SECOND_REGION_CONSTRAINT');
  assert.equal(
    aws.calls.some((args) => args[0] === 'ssm' && args[1] === 'send-command'),
    false
  );
});

test('run second-region in us-west-2 executes SCENARIO=second-region', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const west = terraformOutputFixture({
    topology_declaration: {
      value: { region: 'us-west-2', test_id: 'west-holdout', app_pool_size: 250 },
    },
  });
  const result = await runWith(['run', '--scenario', 'second-region', '--json'], {
    now: laterDayNow,
    env: { CWM_CAMPAIGN_ID: 'west', CWM_RUN_ID: 'second-region-1', CWM_WARMUP: '1s', CWM_DURATION: '1s' },
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: west, stderr: '' }),
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.scenario, 'second-region');
  assert.equal(result.payload.region, 'us-west-2');
  assert.equal(result.payload.aliasOf, null);
  const script = k6ScriptFrom(aws);
  assert.match(script, /SCENARIO='second-region'/);
  assert.doesNotMatch(script, /SCENARIO='normal'/);
});

test('run app-bound against pool 250 fails', async () => {
  const aws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const result = await runWith(['run', '--scenario', 'app-bound', '--json'], {
    now: laterDayNow,
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.payload.error.code, 'POOL_MISMATCH');
});

test('run idle records a fit date and uses SCENARIO=idle', async () => {
  const stored = {};
  const aws = createAwsMock(ssmOnlineHandlers({ poolSize: 250 }));
  const result = await runWith(['run', '--scenario', 'idle', '--json'], {
    now: () => new Date('2026-09-01T08:00:00.000Z'),
    statePath: '/tmp/cwm-adapter-state-test.json',
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
      fs: {
        readFile: async () => {
          const err = new Error('no state');
          err.code = 'ENOENT';
          throw err;
        },
        writeFile: async (_path, body) => {
          stored.body = body;
        },
        mkdir: async () => {},
      },
    },
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.payload.scenario, 'idle');
  assert.equal(result.payload.split, 'fit');
  assert.match(stored.body, /2026-09-01/);
  assert.match(k6ScriptFrom(aws), /SCENARIO='idle'/);
});

const ALL_RUNNABLE = [
  'idle',
  'normal',
  'peak',
  'burst',
  'pool-bound',
  'cpu-only',
];

const memoryFs = {
  readFile: async () => {
    const err = new Error('no state');
    err.code = 'ENOENT';
    throw err;
  },
  writeFile: async () => {},
  mkdir: async () => {},
};

for (const key of ALL_RUNNABLE) {
  test(`run ${key} is a first-class scenario (not remapped)`, async () => {
    const spec = getScenario(key);
    const aws = createAwsMock(ssmOnlineHandlers({ poolSize: spec.expectedPoolSize || 250 }));
    const result = await runWith(['run', '--scenario', key, '--json'], {
      now: laterDayNow,
      statePath: '/tmp/cwm-adapter-state-matrix.json',
      env: { CWM_CAMPAIGN_ID: 'matrix', CWM_RUN_ID: `${key}-1`, CWM_WARMUP: '1s', CWM_DURATION: '1s' },
      deps: {
        runAws: aws,
        runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture(), stderr: '' }),
        fs: memoryFs,
      },
    });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.payload.scenario, key);
    assert.equal(result.payload.aliasOf, null);
    if (key === 'burst') {
      assert.equal(result.payload.requiresCompleteCollect, true);
      assert.equal(result.payload.completeness, 'collected');
      assert.equal(result.payload.knownGap, undefined);
    }
  });
}
