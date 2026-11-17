import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../scripts/lib/adapter/main.mjs';
import { getScenario, listScenarioKeys } from '../../scripts/lib/adapter/scenarios.mjs';
import { assertLadderPosition, resolveLadder } from '../../scripts/lib/adapter/ladder.mjs';
import {
  OCI_HOLDOUT_LADDER,
  OCI_HOLDOUT_REGION,
  OCI_HOLDOUT_TEST_ID_RE,
  assertOciHoldoutTestId,
} from '../../scripts/lib/adapter/oci-catalog.mjs';
import { MemoryStream } from '../helpers.mjs';

const KEYS = ['oci-holdout-10', 'oci-holdout-100', 'oci-holdout-500', 'oci-holdout-1000'];

test('oci-holdout-v1 keys are registered with the preregistered ladder, region and timings', () => {
  const listed = listScenarioKeys();
  for (const key of KEYS) assert.ok(listed.includes(key), `${key} listed`);
  const lean = { 10: 'idle', 100: 'normal', 500: 'peak', 1000: 'burst' };
  for (const key of KEYS) {
    const spec = getScenario(key);
    assert.equal(spec.cloud, 'oci');
    assert.equal(spec.kind, 'holdout');
    assert.equal(spec.split, 'holdout');
    assert.equal(spec.requiredRegion, OCI_HOLDOUT_REGION);
    assert.equal(OCI_HOLDOUT_REGION, 'us-ashburn-1');
    assert.deepEqual(spec.ladder, [10, 100, 500, 1000]);
    assert.equal(spec.enforceLadder, true);
    assert.equal(spec.warmup, '300s');
    assert.equal(spec.duration, '900s');
    assert.equal(spec.expectedPoolSize, 250);
    assert.equal(spec.expectedAppCount, 2);
    assert.equal(spec.expectedProfile, 'lean');
    assert.equal(spec.workload.script, 'oci-holdout.js');
    assert.equal(spec.workload.envValue, key);
    assert.ok(lean[spec.rps]);
    assert.equal(spec.aliasOf, null);
  }
});

test('oci-holdout-v1 ladder accepts only 10 -> 100 -> 500 -> 1000 in order', () => {
  const plan = resolveLadder(getScenario('oci-holdout-10'), {});
  assert.deepEqual(plan, { ladder: [...OCI_HOLDOUT_LADDER], enforce: true });
  const history = [];
  for (const key of KEYS) {
    const spec = getScenario(key);
    const meta = assertLadderPosition(spec, plan, history);
    assert.equal(meta.rung_pos, history.length + 1);
    history.push({ rps: spec.rps });
  }
  assert.throws(() => assertLadderPosition(getScenario('oci-holdout-100'), plan, []), { code: 'LADDER_ORDER' });
  assert.throws(() => assertLadderPosition(getScenario('oci-holdout-10'), plan, history), { code: 'LADDER_ORDER' });
  assert.throws(() => resolveLadder(getScenario('oci-holdout-10'), { CWM_LADDER: '1000,500,100,10' }), {
    code: 'LADDER_ORDER',
  });
});

test('oci-holdout-v1 apply ids', () => {
  for (const ok of ['oci-holdout-v1-r1-ad1-20261120', 'oci-holdout-v1-r2-ad3b-20261121']) {
    assert.match(ok, OCI_HOLDOUT_TEST_ID_RE);
    assertOciHoldoutTestId(getScenario('oci-holdout-10'), ok);
  }
  for (const bad of ['oci-holdout-v1-r3-ad1-20261120', 'oci-holdout-v1-r1-ad4-20261120', 'oci-holdout-v1-r1-20261120', 'gcp-holdout-v2-r1-20261120']) {
    assert.throws(() => assertOciHoldoutTestId(getScenario('oci-holdout-10'), bad), { code: 'TEST_ID_MISMATCH' });
  }
});

for (const command of ['run', 'collect']) {
  test(`${command} refuses every OCI key with OCI_HARNESS_NOT_PINNED before any cloud call`, async () => {
    for (const key of KEYS) {
      const stdout = new MemoryStream();
      const stderr = new MemoryStream();
      const calls = [];
      const forbidden = () => {
        calls.push('cloud');
        throw new Error('no cloud call expected');
      };
      const code = await main([command, '--scenario', key, '--json'], {
        stdout,
        stderr,
        env: { CWM_TEST_ID: 'oci-holdout-v1-r1-ad1-20261120' },
        statePath: '/nonexistent/oci-holdout-state.json',
        deps: { runAws: forbidden, runGcloud: forbidden, runTerraform: forbidden, fs: {} },
      });
      assert.equal(code, 1);
      const payload = JSON.parse(stdout.toString());
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'OCI_HARNESS_NOT_PINNED');
      assert.notEqual(payload.error.code, 'UNKNOWN_SCENARIO');
      assert.deepEqual(calls, []);
    }
  });
}

test('an unknown oci key is still UNKNOWN_SCENARIO', async () => {
  const stdout = new MemoryStream();
  const code = await main(['run', '--scenario', 'oci-holdout-300', '--json'], { stdout, stderr: new MemoryStream(), env: {} });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.toString()).error.code, 'UNKNOWN_SCENARIO');
});

test('load/lib/common.js gives each OCI key its own SCENARIO identity at the lean rung rate', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../load/lib/common.js', import.meta.url), 'utf8');
  const suffix = text.slice(text.indexOf('export const OCI_HOLDOUT_RPS'));
  for (const [key, rps] of [['oci-holdout-10', 10], ['oci-holdout-100', 100], ['oci-holdout-500', 500], ['oci-holdout-1000', 1000]]) {
    assert.match(suffix, new RegExp(`'${key}': ${rps},`));
  }
});

test('load/oci-holdout.js keeps the lean request function byte-identical to load/scenarios.js', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const fn = (text) => text.slice(text.indexOf('const headers ='));
  assert.equal(fn(read('load/oci-holdout.js')), fn(read('load/scenarios.js')));
  assert.match(read('load/oci-holdout.js'), /OCI_HOLDOUT_RPS as RPS/);
});
