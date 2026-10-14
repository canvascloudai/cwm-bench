// Offline sizing fixture for GET /api/metrics at the dbsat 1500-RPS peak.
// Built with the real app-typical aggregator (createAggregator/present) and
// the response envelope server.js sends. Synthetic sizes only.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const metrics = require('../../app-typical/src/metrics.js');

// Deterministic PRNG so fixture bytes are reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function buildMetricsBody({ minutes = 240, denseMinutes = minutes, workers = 2,
  acquisitionsPerMinute = 22500, bucketsPerMinute = 512, startMs = Date.UTC(2026, 9, 14, 0, 0), seed = 1 } = {}) {
  const rand = rng(seed);
  const agg = metrics.createAggregator();
  const perWorker = Math.floor(acquisitionsPerMinute / workers);
  for (let m = 0; m < minutes; m++) {
    const minute = new Date(startMs + m * 60000).toISOString();
    const dense = m >= minutes - denseMinutes;
    const buckets = dense ? bucketsPerMinute : 8;
    // Bucket span ~0.05 ms .. ~2 s (ratio 1.001 => indices -2996 .. 7601); offset per worker
    // so merged minute carries up to `bucketsPerMinute` distinct keys across workers.
    for (let w = 0; w < workers; w++) {
      const row = metrics.emptyMinute(minute);
      const keys = buckets / workers;
      let left = perWorker;
      for (let k = 0; k < keys; k++) {
        const key = -2996 + Math.floor(rand() * 10597);
        const count = k === keys - 1 ? left : Math.max(1, Math.floor((perWorker / keys) * (0.5 + rand())));
        if (count <= 0) break;
        left -= count;
        row.waitBuckets[key] = (row.waitBuckets[key] || 0) + count;
      }
      row.acquires = perWorker;
      row.queued = Math.floor(perWorker * rand());
      row.queueRejects = Math.floor(10 * rand());
      row.waitSumMs = perWorker * rand() * 400;
      row.waitMaxMs = 1500 + rand() * 1000;
      row.queueDepthMax = Math.floor(rand() * 200);
      row.eventLoopDelayP99Ms = rand() * 50;
      row.eventLoopDelayMaxMs = 50 + rand() * 100;
      row.workers = 1;
      agg.add(row);
    }
  }
  return { service: 'cwm-bench-app', gitSha: '53853a8aabf4eabd801f7614f149802de0e0fdb5', minutes: agg.snapshot() };
}
