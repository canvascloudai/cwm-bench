/**
 * Three 1000 RPS diagnostics. These classify the Burst cell; they do not
 * assert a root cause of any published  simulated-vs-reference gap.
 *
 *   pool-bound  — same mix as scenarios.js; expects APP_POOL_SIZE=250
 *                 (terraform default). Saturates 2 x 250 toward the
 *                 declared RDS max_connections=500.
 *   app-bound   — same mix; expects APP_POOL_SIZE=40 on the app nodes.
 *                 Re-apply terraform with -var='app_pool_size=40' first.
 *   cpu-only    — GET /api/cpu-spin only. No MySQL on the request path.
 *
 * Protocol: warmup then 15 min steady at 1000 RPS. Same defaults as
 * scenarios.js. Tag errors by class when the app returns one.
 *
 * Honesty: do not retune coefficients from a diagnostic. Hold Burst out
 * of the fit set. Keep the Burst gap visible until v1 measurements exist.
 */

import http from 'k6/http';
import { check } from 'k6';
import {
  DEFAULT_WARMUP,
  DEFAULT_DURATION,
  arrivalScenarios,
  envOr,
  requireTarget,
  randomProductId,
  recordErrorClass,
  handleRunSummary,
  SUMMARY_TREND_STATS,
} from './lib/common.js';

const DIAGNOSTICS = {
  'pool-bound': { expectedPool: 250, mode: 'mix' },
  'app-bound': { expectedPool: 40, mode: 'mix' },
  'cpu-only': { expectedPool: null, mode: 'cpu' },
};

const diagnostic = envOr('DIAGNOSTIC', 'pool-bound');
if (!Object.prototype.hasOwnProperty.call(DIAGNOSTICS, diagnostic)) {
  throw new Error(`DIAGNOSTIC must be one of ${Object.keys(DIAGNOSTICS).join(', ')}`);
}

const spec = DIAGNOSTICS[diagnostic];
const warmup = envOr('WARMUP', DEFAULT_WARMUP);
const duration = envOr('DURATION', DEFAULT_DURATION);
const target = requireTarget();
const cpuSpinMs = Number(envOr('CPU_SPIN_MS', '20'));
const rps = 1000;

export const options = {
  discardResponseBodies: false,
  summaryTrendStats: SUMMARY_TREND_STATS,
  scenarios: arrivalScenarios(rps, warmup, duration),
  tags: {
    campaign_id: envOr('CAMPAIGN_ID', 'unset-campaign'),
    run_id: envOr('RUN_ID', 'unset-run'),
    split: envOr('SPLIT', 'holdout'),
    diagnostic: diagnostic,
    scenario: 'burst',
    expected_app_pool_size: String(spec.expectedPool === null ? 'n/a' : spec.expectedPool),
  },
};

const headers = { 'Content-Type': 'application/json' };

export default function diagnosticRun() {
  let res;
  if (spec.mode === 'cpu') {
    res = http.get(`${target}/api/cpu-spin?ms=${cpuSpinMs}`, {
      tags: { name: 'GET /api/cpu-spin' },
    });
  } else {
    const roll = Math.random();
    if (roll < 0.7) {
      res = http.get(`${target}/api/products/${randomProductId()}`, {
        tags: { name: 'GET /api/products/:id' },
      });
    } else if (roll < 0.9) {
      res = http.get(`${target}/api/products`, { tags: { name: 'GET /api/products' } });
    } else {
      res = http.post(
        `${target}/api/orders`,
        JSON.stringify({ productId: randomProductId(), qty: 1 }),
        { headers, tags: { name: 'POST /api/orders' } }
      );
    }
  }

  const errorClass = recordErrorClass(res);
  check(res, {
    'status is 2xx or classified error': (r) =>
      (r.status >= 200 && r.status < 300) || errorClass !== null,
  });
}

export function handleSummary(data) {
  return handleRunSummary(data);
}
