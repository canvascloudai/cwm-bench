import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseK6Summary } from '../../scripts/lib/adapter/assemble.mjs';

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


test('does not compare a warm-up aggregate with steady-window error classes', () => {
  const parsed = parseK6Summary({
    metrics: {
      'http_reqs{phase:steady}': { values: { rate: 90, count: 900 } },
      'http_req_failed{phase:steady}': { values: { rate: 0.1, passes: 90, fails: 810 } },
      errors_by_class: { values: { count: 105 } },
      'errors_by_class{error_class:db_timeout,phase:warmup}': { values: { count: 100 } },
      'errors_by_class{error_class:db_timeout,phase:steady}': { values: { count: 3 } },
      'errors_by_class{error_class:internal,phase:steady}': { values: { count: 2 } },
    },
  });
  assert.equal(parsed.errorClassEvidence, 'classified-counter');
});


test('rejects contradictory totals from the selected steady window', () => {
  const parsed = parseK6Summary({
    metrics: {
      'http_reqs{phase:steady}': { values: { rate: 90, count: 900 } },
      'http_req_failed{phase:steady}': { values: { rate: 0.1, passes: 90, fails: 810 } },
      'errors_by_class{phase:steady}': { values: { count: 8 } },
      'errors_by_class{error_class:db_timeout,phase:steady}': { values: { count: 3 } },
      'errors_by_class{error_class:internal,phase:steady}': { values: { count: 2 } },
    },
  });
  assert.equal(parsed.errorClassEvidence, 'contradictory');
  assert.equal(parsed.errorClassCountsPresent, false);
});
