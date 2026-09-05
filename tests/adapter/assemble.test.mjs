import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessAlb5xxEvidence,
  parseK6Summary,
} from '../../scripts/lib/adapter/assemble.mjs';

test('k6 error counters use the same steady phase as request counters', () => {
  const parsed = parseK6Summary({
    metrics: {
      'http_req_duration{phase:steady}': { values: { med: 12, 'p(95)': 25, 'p(99)': 40 } },
      'http_reqs{phase:steady}': { values: { rate: 90, count: 900 } },
      'http_req_failed{phase:steady}': { values: { rate: 0.1, count: 90 } },
      'errors_by_class{error_class:db_timeout,phase:warmup}': { values: { count: 100 } },
      'errors_by_class{error_class:db_timeout,phase:steady}': { values: { count: 3 } },
      'errors_by_class{error_class:internal,phase:steady}': { values: { count: 2 } },
    },
  });
  assert.equal(parsed.errorClasses.db_timeout, 3);
  assert.equal(parsed.errorClasses.internal, 2);
  assert.equal(parsed.goodputRps, 81);
  assert.equal(parsed.latencyPercentilesPresent, true);
});

test('k6 warmup-only error counters do not contradict a clean steady phase', () => {
  const parsed = parseK6Summary({
    metrics: {
      'http_req_duration{phase:steady}': { values: { med: 12, 'p(95)': 25, 'p(99)': 40 } },
      'http_reqs{phase:steady}': { values: { rate: 90, count: 900 } },
      'http_req_failed{phase:steady}': { values: { rate: 0, passes: 0, fails: 900 } },
      'errors_by_class{error_class:internal,phase:warmup}': { values: { count: 3 } },
    },
  });

  assert.equal(parsed.errorClassEvidence, 'zero-http-failure-rate');
  assert.deepEqual(parsed.errorClasses, {
    db_timeout: 0,
    too_many_connections: 0,
    queue_full: 0,
    cpu_overload: 0,
    internal: 0,
    unclassified: 0,
  });
  assert.equal(parsed.classifiedErrorCount, 0);
});

test('k6 contradiction evidence stays raw and is marked contradictory', () => {
  const parsed = parseK6Summary({
    metrics: {
      http_req_duration: { values: { med: 12, 'p(95)': 25, 'p(99)': 40 } },
      http_reqs: { values: { rate: 90, count: 900 } },
      http_req_failed: { values: { rate: 0, passes: 0, fails: 900 } },
      errors_by_class: { values: { count: 3 } },
      'errors_by_class{error_class:db_timeout}': { values: { count: 3 } },
    },
  });

  assert.equal(parsed.errorClassEvidence, 'contradictory');
  assert.equal(parsed.errorClassCountsPresent, false);
  assert.equal(parsed.errorClasses, null);
  assert.deepEqual(parsed.httpReqFailed, { rate: 0, passes: 0, fails: 900 });
  assert.equal(parsed.counterConsistency.valid, true);
});

test('rate-consistent failed requests become explicit unclassified errors', () => {
  const parsed = parseK6Summary({
    metrics: {
      http_reqs: { values: { rate: 90, count: 900 } },
      http_req_failed: { values: { rate: 1 / 900, passes: 1, fails: 899 } },
      errors_by_class: { values: { count: 0 } },
      'errors_by_class{error_class:internal}': { values: { count: 0 } },
    },
  });

  assert.equal(parsed.errorClassEvidence, 'unclassified-http-failures');
  assert.equal(parsed.errorClassCountsPresent, true);
  assert.equal(parsed.errorClasses.unclassified, 1);
  assert.equal(parsed.classifiedErrorCount, 1);
  assert.equal(parsed.counterConsistency.valid, true);
});

test('k6 counter totals and rates are explicitly flagged when inconsistent', () => {
  const parsed = parseK6Summary({
    metrics: {
      http_reqs: { values: { rate: 90, count: 900 } },
      http_req_failed: { values: { rate: 0.2, passes: 0, fails: 900 } },
    },
  });

  assert.equal(parsed.counterConsistency.valid, false);
  assert.match(parsed.counterConsistency.reasons[0], /rate 0.2/);
  assert.deepEqual(parsed.httpReqFailed, { rate: 0.2, passes: 0, fails: 900 });
});

test('an ELB 5xx can explain a missing target 5xx series', () => {
  const evidence = assessAlb5xxEvidence({
    alb_request_count: {
      datapoints: [
        { timestamp: '2026-09-05T07:06:00+00:00', sum: 60000 },
        { timestamp: '2026-09-05T07:07:00+00:00', sum: 60001 },
      ],
    },
    alb_http_target_2xx: {
      datapoints: [
        { timestamp: '2026-09-05T07:06:00+00:00', sum: 60000 },
        { timestamp: '2026-09-05T07:07:00+00:00', sum: 60000 },
      ],
    },
    alb_http_target_5xx: { datapoints: [] },
    alb_http_elb_5xx: {
      datapoints: [
        { timestamp: '2026-09-05T07:07:00+00:00', sum: 1 },
      ],
    },
  });

  assert.equal(evidence.target5xxInferredZero, true);
  assert.equal(evidence.elb5xxPresent, true);
  assert.equal(evidence.contradictory, false);
});
