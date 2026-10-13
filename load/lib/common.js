/**
 * Shared k6 helpers.
 *
 * Tag errors by the machine-readable class the app returns:
 *   db_timeout | too_many_connections | queue_full | cpu_overload | internal
 *
 * iops_throttle is CloudWatch-derived. k6 cannot observe BurstBalance.
 */

import { Counter, Rate } from 'k6/metrics';

export const PRODUCT_COUNT = 200;

export const errorsByClass = new Counter('errors_by_class');
export const classifiedErrorRate = new Rate('classified_error_rate');

export const RPS = Object.freeze({
  idle: 10,
  normal: 100,
  peak: 500,
  burst: 1000,
  // Holdouts are first-class keys. They are not aliases of `normal`.
  // later-day: same mix/RPS as the normal rung, but a distinct holdout
  // identity that the worker adapter will only run on a later UTC day.
  'later-day': 100,
  // second-region: same mix/RPS, distinct holdout identity that the
  // worker adapter will only run in us-west-2.
  'second-region': 100,
});

export const DEFAULT_WARMUP = '5m';
export const DEFAULT_DURATION = '15m';

/** Include p99 so collect can stitch schema latency without inventing it. */
export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

export function envOr(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

export function requireTarget() {
  // Default host is invalid on purpose so `k6 inspect` (CI) can parse
  // the script without an ALB. Real runs must export TARGET.
  const target = envOr('TARGET', 'http://cwm-bench.example.invalid');
  return target.replace(/\/$/, '');
}

export function resultsDir() {
  const campaign = envOr('CAMPAIGN_ID', 'unset-campaign');
  const run = envOr('RUN_ID', 'unset-run');
  return envOr('RESULTS_DIR', `results/raw/${campaign}/${run}`);
}

export function randomProductId() {
  return 1 + Math.floor(Math.random() * PRODUCT_COUNT);
}

export function extractErrorClass(res) {
  try {
    const body = res.json();
    if (body && body.error && body.error.class) {
      return String(body.error.class);
    }
  } catch (_err) {
    // not JSON
  }
  // Transport failures have status 0 and no application error body. Keep
  // them in the same machine-readable counter as other failed requests so
  // the adapter can reconcile errors_by_class with http_req_failed.
  if (res.status === 0 || res.error || res.error_code) {
    return 'unclassified';
  }
  if (res.status >= 400) {
    return 'unclassified';
  }
  return null;
}

export function recordErrorClass(res) {
  const errorClass = extractErrorClass(res);
  if (errorClass) {
    errorsByClass.add(1, { error_class: errorClass });
    classifiedErrorRate.add(1);
  } else {
    classifiedErrorRate.add(0);
  }
  return errorClass;
}

export function vuBudget(rps) {
  // Arrival-rate VUs ≈ RPS * expected in-flight seconds, plus headroom
  // for timeouts. Burst 1000 RPS with ~1s timeout worst-case needs more
  // than RPS * latency. These are generator allocations, not measurements.
  if (rps <= 10) {
    return { preAllocatedVUs: 20, maxVUs: 50 };
  }
  if (rps <= 100) {
    return { preAllocatedVUs: 80, maxVUs: 200 };
  }
  if (rps <= 500) {
    return { preAllocatedVUs: 400, maxVUs: 800 };
  }
  return { preAllocatedVUs: 800, maxVUs: 1600 };
}

export function arrivalScenarios(rps, warmup, duration) {
  const vu = vuBudget(rps);
  return {
    warmup: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: vu.preAllocatedVUs,
      maxVUs: vu.maxVUs,
      stages: [{ duration: warmup, target: rps }],
      gracefulStop: '30s',
      tags: { phase: 'warmup' },
    },
    steady: {
      executor: 'constant-arrival-rate',
      rate: rps,
      timeUnit: '1s',
      duration: duration,
      preAllocatedVUs: vu.preAllocatedVUs,
      maxVUs: vu.maxVUs,
      startTime: warmup,
      gracefulStop: '30s',
      tags: { phase: 'steady' },
    },
  };
}

export function handleRunSummary(data) {
  const dir = resultsDir();
  return {
    stdout:
      `cwm-bench k6 finished. results dir=${dir}\n` +
      `Do not treat this summary as a calibrated measurement.\n`,
    [`${dir}/summary.json`]: JSON.stringify(data, null, 2),
  };
}

// Typical-profile rungs (total RPS through the ALB). The RPS object above is unchanged.
export const TYPICAL_RPS = Object.freeze({
  'typical-fit-20': 20,
  'typical-fit-100': 100,
  'typical-fit-200': 200,
  'typical-holdout-300': 300,
  'typical-saturation-500': 500,
  // Same mix as the 100 and 300 typical rungs. The adapter, not this map,
  // enforces a later UTC day (typical-later-day*) or us-west-2
  // (typical-second-region*). Other typical keys stay on us-east-2.
  'typical-later-day': 100,
  'typical-later-day-300': 300,
  'typical-second-region': 100,
  'typical-second-region-300': 300,
  // typical-scale-v1: total RPS on 1, 2, or 3 app servers. The adapter
  // enforces us-east-2 and the key's expected app count.
  'typical-scale-1x-100': 100,
  'typical-scale-1x-200': 200,
  'typical-scale-1x-300': 300,
  'typical-scale-2x-100': 100,
  'typical-scale-2x-200': 200,
  'typical-scale-2x-300': 300,
  'typical-scale-3x-100': 100,
  'typical-scale-3x-200': 200,
  'typical-scale-3x-300': 300,
  // typical-p95-v1: same totals, reverse ladder 300 → 200 → 100.
  // The adapter enforces that order and the key's app count.
  'typical-p95-1x-300': 300,
  'typical-p95-1x-200': 200,
  'typical-p95-1x-100': 100,
  'typical-p95-2x-300': 300,
  'typical-p95-2x-200': 200,
  'typical-p95-2x-100': 100,
  'typical-p95-3x-300': 300,
  'typical-p95-3x-200': 200,
  'typical-p95-3x-100': 100,
  // typical-dbsat-v1: ascending 300 → 1500 on 2, 3, or 4 app servers.
  'typical-dbsat-2x-300': 300,
  'typical-dbsat-2x-500': 500,
  'typical-dbsat-2x-700': 700,
  'typical-dbsat-2x-900': 900,
  'typical-dbsat-2x-1100': 1100,
  'typical-dbsat-2x-1300': 1300,
  'typical-dbsat-2x-1500': 1500,
  'typical-dbsat-3x-300': 300,
  'typical-dbsat-3x-500': 500,
  'typical-dbsat-3x-700': 700,
  'typical-dbsat-3x-900': 900,
  'typical-dbsat-3x-1100': 1100,
  'typical-dbsat-3x-1300': 1300,
  'typical-dbsat-3x-1500': 1500,
  'typical-dbsat-4x-300': 300,
  'typical-dbsat-4x-500': 500,
  'typical-dbsat-4x-700': 700,
  'typical-dbsat-4x-900': 900,
  'typical-dbsat-4x-1100': 1100,
  'typical-dbsat-4x-1300': 1300,
  'typical-dbsat-4x-1500': 1500,
});

/**
 * Optional generator split (typical-dbsat-v1, two generators). K6_SEGMENT is
 * this generator's execution segment ("0:1/2" or "1/2:1"); both generators
 * share K6_SEGMENT_SEQUENCE ("0,1/2,1"). Unset means one generator.
 */
export function executionSegmentOptions() {
  const segment = __ENV.K6_SEGMENT || '';
  const sequence = __ENV.K6_SEGMENT_SEQUENCE || '';
  if (!segment) return {};
  if (!sequence) throw new Error('K6_SEGMENT requires K6_SEGMENT_SEQUENCE');
  return { executionSegment: segment, executionSegmentSequence: sequence };
}

/**
 * typical-dbsat-v1 VU allocation scales with the target rate:
 * preAllocatedVUs = ceil(rps × VU_PRE_S), maxVUs = ceil(rps × VU_MAX_S).
 * Defaults 0.5 s / 2.5 s; the dry run may change them once, then they are
 * frozen in the prereg evidence package. Other keys keep vuBudget().
 */
export function scaledVuBudget(rps, preSeconds = 0.5, maxSeconds = 2.5) {
  const pre = Math.max(20, Math.ceil(rps * Number(preSeconds)));
  const max = Math.max(pre, Math.ceil(rps * Number(maxSeconds)));
  return { preAllocatedVUs: pre, maxVUs: max };
}

/** arrivalScenarios with typical-dbsat-v1 RPS-scaled VUs. */
export function dbsatArrivalScenarios(rps, warmup, duration, preSeconds, maxSeconds) {
  const scenarios = arrivalScenarios(rps, warmup, duration);
  const vu = scaledVuBudget(rps, preSeconds, maxSeconds);
  for (const name of Object.keys(scenarios)) {
    scenarios[name] = { ...scenarios[name], ...vu };
  }
  return scenarios;
}
