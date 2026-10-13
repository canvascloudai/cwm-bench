import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const m = require('../../app-typical/src/metrics.js');

test('log buckets bound each wait within 0.1%', () => {
  for (const ms of [0.01, 0.37, 3, 41.5, 2500]) {
    const upper = m.bucketUpperMs(m.bucketIndex(ms));
    assert.ok(upper >= ms && upper <= ms * 1.0011, `${ms} -> ${upper}`);
  }
});

test('aggregator merges workers per minute and reports p95 upper bound', () => {
  const agg = m.createAggregator();
  const a = m.emptyMinute('2026-10-12T14:00:00.000Z');
  const b = m.emptyMinute('2026-10-12T14:00:00.000Z');
  for (let i = 0; i < 90; i += 1) m.recordAcquire(a, 0.2, false);
  for (let i = 0; i < 10; i += 1) m.recordAcquire(b, 40, true);
  a.workers = 1; b.workers = 1; a.queueDepthMax = 2; b.queueDepthMax = 3;
  agg.add(a); agg.add(b);
  const [row] = agg.snapshot();
  assert.equal(row.acquires, 100);
  assert.equal(row.queued, 10);
  assert.equal(row.workers, 2);
  assert.equal(row.queueDepthMax, 5);
  assert.equal(row.queuedShare, 0.1);
  assert.ok(row.waitP95UpperMs >= 40 && row.waitP95UpperMs <= 40.05);
});

test('aggregator retains only the newest minutes', () => {
  const agg = m.createAggregator(2);
  for (const minute of ['2026-10-12T14:00:00.000Z', '2026-10-12T14:01:00.000Z', '2026-10-12T14:02:00.000Z']) {
    agg.add(m.emptyMinute(minute));
  }
  assert.deepEqual(agg.snapshot().map((r) => r.minute), ['2026-10-12T14:01:00.000Z', '2026-10-12T14:02:00.000Z']);
});

test('instrumentPool times acquisitions, rotates minutes, counts queue rejects', async () => {
  let wall = Date.parse('2026-10-12T14:00:10Z');
  let clock = 0;
  const fakePool = {
    pool: { _connectionQueue: [], _freeConnections: [] },
    async getConnection() {
      clock += 7;
      if (this.reject) throw new Error('Queue limit reached.');
      return { release() {} };
    },
  };
  const timed = m.instrumentPool(fakePool, { now: () => clock, wall: () => wall });
  await timed.getConnection();
  assert.equal(timed.current().acquires, 1);
  assert.equal(timed.current().queued, 1);
  assert.equal(timed.current().waitMaxMs, 7);
  fakePool.reject = true;
  await assert.rejects(timed.getConnection());
  assert.equal(timed.current().queueRejects, 1);
  wall += 60_000;
  timed.rotate();
  const rows = timed.drain();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minute, '2026-10-12T14:00:00.000Z');
});
