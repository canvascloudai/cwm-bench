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
