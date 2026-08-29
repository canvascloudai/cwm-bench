/**
 * Canonical rungs: idle 10, normal 100, peak 500, burst 1000 RPS.
 *
 * Protocol: warmup, then 15 min steady.
 *   WARMUP default 5m, DURATION default 15m.
 *
 * Mix (workload definition):
 *   70% GET /api/products/:id
 *   20% GET /api/products
 *   10% POST /api/orders
 *
 * Honesty: this script produces load. It does not compute a composite
 * accuracy score and it does not retune coefficients.
 */

import http from 'k6/http';
import { check } from 'k6';
import {
  RPS,
  DEFAULT_WARMUP,
  DEFAULT_DURATION,
  arrivalScenarios,
  envOr,
  requireTarget,
  randomProductId,
  recordErrorClass,
  handleRunSummary,
} from './lib/common.js';

const scenarioName = envOr('SCENARIO', 'idle');
if (!Object.prototype.hasOwnProperty.call(RPS, scenarioName)) {
  throw new Error(`SCENARIO must be one of ${Object.keys(RPS).join(', ')}`);
}

const rps = RPS[scenarioName];
const warmup = envOr('WARMUP', DEFAULT_WARMUP);
const duration = envOr('DURATION', DEFAULT_DURATION);
const target = requireTarget();

export const options = {
  discardResponseBodies: false,
  scenarios: arrivalScenarios(rps, warmup, duration),
  tags: {
    campaign_id: envOr('CAMPAIGN_ID', 'unset-campaign'),
    run_id: envOr('RUN_ID', 'unset-run'),
    split: envOr('SPLIT', 'unspecified'),
    diagnostic: 'canonical',
    scenario: scenarioName,
  },
};

const headers = { 'Content-Type': 'application/json' };

export default function scenario() {
  const roll = Math.random();
  let res;
  if (roll < 0.7) {
    const id = randomProductId();
    res = http.get(`${target}/api/products/${id}`, { tags: { name: 'GET /api/products/:id' } });
  } else if (roll < 0.9) {
    res = http.get(`${target}/api/products`, { tags: { name: 'GET /api/products' } });
  } else {
    const payload = JSON.stringify({ productId: randomProductId(), qty: 1 });
    res = http.post(`${target}/api/orders`, payload, {
      headers,
      tags: { name: 'POST /api/orders' },
    });
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
