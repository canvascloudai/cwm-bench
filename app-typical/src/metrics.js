'use strict';

/**
 * typical-dbsat-v1 pool-wait instrumentation.
 *
 * Each worker times every mysql2 pool acquisition (getConnection → acquired)
 * and samples event-loop delay. At each UTC minute boundary the worker sends
 * that minute's histogram to the primary over cluster IPC. The primary keeps
 * the last RETAIN_MINUTES minutes merged across workers and serves them to
 * GET /api/metrics (any worker forwards the request to the primary).
 *
 * Only completed minutes are reported. Collect therefore waits at least one
 * minute past the steady window before reading this endpoint.
 */

// Sparse log buckets, ratio 1.001 (~0.1% resolution), so the merged
// pool-wait p95 matches nearest rank on raw samples to within 0.1%.
// Waits below 1 µs share bucket floor(log(0.001)/log(1.001)).
const WAIT_BUCKET_RATIO = 1.001;
const LOG_RATIO = Math.log(WAIT_BUCKET_RATIO);
const RETAIN_MINUTES = 240;

function emptyMinute(minute) {
  return {
    minute,
    acquires: 0,
    queued: 0,
    queueRejects: 0,
    waitSumMs: 0,
    waitMaxMs: 0,
    waitBuckets: {},
    queueDepthMax: 0,
    eventLoopDelayP99Ms: 0,
    eventLoopDelayMaxMs: 0,
    workers: 0,
  };
}

function bucketIndex(ms) {
  return Math.floor(Math.log(Math.max(ms, 0.001)) / LOG_RATIO);
}

function bucketUpperMs(index) {
  return WAIT_BUCKET_RATIO ** (index + 1);
}

function minuteOf(ms) {
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function recordAcquire(row, waitMs, queued) {
  row.acquires += 1;
  if (queued) row.queued += 1;
  row.waitSumMs += waitMs;
  if (waitMs > row.waitMaxMs) row.waitMaxMs = waitMs;
  const key = bucketIndex(waitMs);
  row.waitBuckets[key] = (row.waitBuckets[key] || 0) + 1;
}

function mergeMinute(into, from) {
  into.acquires += from.acquires;
  into.queued += from.queued;
  into.queueRejects += from.queueRejects;
  into.waitSumMs += from.waitSumMs;
  into.waitMaxMs = Math.max(into.waitMaxMs, from.waitMaxMs);
  for (const [key, count] of Object.entries(from.waitBuckets || {})) {
    into.waitBuckets[key] = (into.waitBuckets[key] || 0) + count;
  }
  // Queue depth is per worker pool; the server-level figure is the sum of
  // worker maxima (an upper bound on simultaneous waiters).
  into.queueDepthMax += from.queueDepthMax;
  into.eventLoopDelayP99Ms = Math.max(into.eventLoopDelayP99Ms, from.eventLoopDelayP99Ms);
  into.eventLoopDelayMaxMs = Math.max(into.eventLoopDelayMaxMs, from.eventLoopDelayMaxMs);
  into.workers += from.workers || 1;
  return into;
}

/** Nearest-rank quantile over the log buckets, as the bucket upper bound (ms). */
function waitQuantile(row, q) {
  return histogramQuantile(row.waitBuckets, row.acquires, q);
}

function histogramQuantile(buckets, total, q) {
  if (!total) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const key of Object.keys(buckets).map(Number).sort((a, b) => a - b)) {
    seen += buckets[key];
    if (seen >= rank) return bucketUpperMs(key);
  }
  return null;
}

function present(row) {
  return {
    ...row,
    waitBucketRatio: WAIT_BUCKET_RATIO,
    waitMeanMs: row.acquires ? row.waitSumMs / row.acquires : null,
    waitP95UpperMs: waitQuantile(row, 0.95),
    queuedShare: row.acquires ? row.queued / row.acquires : null,
  };
}

function createAggregator(retain = RETAIN_MINUTES) {
  const minutes = new Map();
  return {
    add(row) {
      const existing = minutes.get(row.minute) || emptyMinute(row.minute);
      existing.workers = existing.workers || 0;
      minutes.set(row.minute, mergeMinute(existing, row));
      const keys = [...minutes.keys()].sort();
      while (keys.length > retain) minutes.delete(keys.shift());
    },
    snapshot() {
      return [...minutes.keys()].sort().map((key) => present(minutes.get(key)));
    },
  };
}

/** Wrap a mysql2/promise pool so every acquisition is timed. */
function instrumentPool(pool, options = {}) {
  const now = options.now || (() => performance.now());
  const wall = options.wall || Date.now;
  let current = emptyMinute(minuteOf(wall()));
  const flushed = [];
  const core = pool.pool || null;
  const queueDepth = () => {
    const queue = core && core._connectionQueue;
    return queue && typeof queue.length === 'number' ? queue.length : 0;
  };
  const rotate = () => {
    const minute = minuteOf(wall());
    if (minute === current.minute) return null;
    const done = current;
    current = emptyMinute(minute);
    flushed.push(done);
    return done;
  };
  async function getConnection() {
    rotate();
    const depth = queueDepth();
    const freeBefore = core && core._freeConnections ? core._freeConnections.length : 1;
    const started = now();
    try {
      const conn = await pool.getConnection();
      const row = current;
      recordAcquire(row, now() - started, freeBefore === 0 || depth > 0);
      if (depth + 1 > row.queueDepthMax) row.queueDepthMax = depth + (freeBefore === 0 ? 1 : 0);
      return conn;
    } catch (err) {
      if (/Queue limit reached/i.test(String(err && err.message))) current.queueRejects += 1;
      throw err;
    }
  }
  return {
    getConnection,
    rotate,
    current: () => current,
    drain() {
      return flushed.splice(0, flushed.length);
    },
  };
}

module.exports = {
  WAIT_BUCKET_RATIO,
  bucketUpperMs,
  histogramQuantile,
  RETAIN_MINUTES,
  emptyMinute,
  bucketIndex,
  minuteOf,
  recordAcquire,
  mergeMinute,
  waitQuantile,
  present,
  createAggregator,
  instrumentPool,
};
