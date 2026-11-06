import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  backendsFromHealthResponse,
  parseInstanceRef,
  summarizeBackendHealth,
  waitForBackendHealth,
} from '../../scripts/lib/adapter/gcp-backend-health.mjs';
import { saveState } from '../../scripts/lib/adapter/state.mjs';
import { isolatedStatePath } from '../helpers.mjs';

const PROJECT = 'example-project';

function healthPayload(states, project = PROJECT) {
  return [{
    backend: `https://www.googleapis.com/compute/v1/projects/${project}/regions/us-central1/instanceGroups/cwm-bench-app`,
    status: {
      healthStatus: states.map((item) => ({
        instance: `https://www.googleapis.com/compute/v1/projects/${project}/zones/${item.zone}/instances/${item.instance}`,
        healthState: item.healthState,
      })),
    },
  }];
}

test('parseInstanceRef keeps zone and name and drops project URLs', () => {
  const parsed = parseInstanceRef(
    `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/us-central1-f/instances/cwm-bench-app-abcd`,
  );
  assert.deepEqual(parsed, { zone: 'us-central1-f', instance: 'cwm-bench-app-abcd' });
  assert.deepEqual(parseInstanceRef('bare-name'), { zone: null, instance: 'bare-name' });
  assert.equal(parseInstanceRef(`https://example/projects/${PROJECT}/global/missing`).instance, 'unknown');
});

test('backendsFromHealthResponse requires every listed backend and hides project ids', () => {
  const backends = backendsFromHealthResponse(healthPayload([
    { zone: 'us-central1-b', instance: 'cwm-bench-app-one', healthState: 'HEALTHY' },
    { zone: 'us-central1-f', instance: 'cwm-bench-app-two', healthState: 'UNHEALTHY' },
  ]));
  assert.deepEqual(backends, [
    { instance: 'cwm-bench-app-one', zone: 'us-central1-b', healthState: 'HEALTHY' },
    { instance: 'cwm-bench-app-two', zone: 'us-central1-f', healthState: 'UNHEALTHY' },
  ]);
  assert.equal(JSON.stringify(backends).includes(PROJECT), false);
  const oneHealthy = summarizeBackendHealth(backends.filter((row) => row.healthState === 'HEALTHY'), 2);
  assert.equal(oneHealthy.allHealthy, false);
  assert.equal(oneHealthy.healthyCount, 1);
  const both = summarizeBackendHealth(backendsFromHealthResponse(healthPayload([
    { zone: 'us-central1-b', instance: 'cwm-bench-app-one', healthState: 'HEALTHY' },
    { zone: 'us-central1-f', instance: 'cwm-bench-app-two', healthState: 'HEALTHY' },
  ])), 2);
  assert.equal(both.allHealthy, true);
});

test('waitForBackendHealth requires a sustained all-healthy window before passing', async () => {
  let elapsed = 0;
  let probes = 0;
  const evidence = await waitForBackendHealth({
    expectedCount: 2,
    backendService: 'cwm-bench-app',
    sustainedMs: 60_000,
    timeoutMs: 180_000,
    pollMs: 5_000,
    nowMs: () => elapsed,
    wallMs: () => Date.parse('2026-11-06T12:00:00.000Z'),
    wait: async (ms) => { elapsed += ms; },
    probe: async () => {
      probes += 1;
      if (elapsed < 15_000) {
        return backendsFromHealthResponse(healthPayload([
          { zone: 'us-central1-b', instance: 'cwm-bench-app-one', healthState: 'HEALTHY' },
        ]));
      }
      return backendsFromHealthResponse(healthPayload([
        { zone: 'us-central1-b', instance: 'cwm-bench-app-one', healthState: 'HEALTHY' },
        { zone: 'us-central1-f', instance: 'cwm-bench-app-two', healthState: 'HEALTHY' },
      ]));
    },
  });
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.backendService, 'cwm-bench-app');
  assert.equal(evidence.expectedCount, 2);
  assert.ok(elapsed >= 75_000);
  assert.ok(probes >= 16);
  assert.match(evidence.firstAllHealthyAt, /2026-11-06T12:00:15/);
  assert.equal(JSON.stringify(evidence).includes(PROJECT), false);
});

test('waitForBackendHealth times out as a replaceable pre-rung failure', async () => {
  let elapsed = 0;
  await assert.rejects(
    () => waitForBackendHealth({
      expectedCount: 2,
      backendService: 'cwm-bench-app',
      sustainedMs: 60_000,
      timeoutMs: 30_000,
      pollMs: 5_000,
      nowMs: () => elapsed,
      wallMs: () => Date.parse('2026-11-06T12:00:00.000Z'),
      wait: async (ms) => { elapsed += ms; },
      probe: async () => backendsFromHealthResponse(healthPayload([
        { zone: 'us-central1-b', instance: 'cwm-bench-app-one', healthState: 'HEALTHY' },
      ])),
    }),
    (err) => {
      assert.equal(err.code, 'GCP_BACKEND_HEALTH_TIMEOUT');
      assert.equal(err.replaceable, true);
      assert.equal(err.faultClass, 'runner');
      assert.equal(err.preRung, true);
      assert.equal(err.backendHealth.status, 'timeout');
      assert.equal(err.backendHealth.lastSnapshot.healthyCount, 1);
      assert.equal(err.backendHealth.lastSnapshot.backendCount, 1);
      assert.equal(JSON.stringify(err.backendHealth).includes(PROJECT), false);
      return true;
    },
  );
  assert.equal(elapsed, 30_000);
});

test('isolatedStatePath and atomic saveState keep per-test JSON intact', async () => {
  const first = isolatedStatePath('cwm-iso-a-');
  const second = isolatedStatePath('cwm-iso-b-');
  assert.notEqual(first, second);
  await saveState(first, { n: 1 });
  await saveState(second, { n: 2 });
  assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), { n: 1 });
  assert.deepEqual(JSON.parse(await readFile(second, 'utf8')), { n: 2 });
  const dir = mkdtempSync(path.join(tmpdir(), 'cwm-atomic-'));
  const target = path.join(dir, 'state.json');
  await saveState(target, { ok: true });
  JSON.parse(await readFile(target, 'utf8'));
});
