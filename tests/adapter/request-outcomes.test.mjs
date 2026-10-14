import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, ROOT), 'utf8');
// Run actual k6 source in a VM without requiring experimental Node flags.
// Only import/export syntax is removed; request and classification code is
// not replaced. HTTP, metrics, and signing are offline dependencies.
const executable = source => source
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
  .replace(/\bexport\s+default\s+function\s+/g, 'function ')
  .replace(/\bexport\s+(const|function|let)\s+/g, '$1 ');

function fixture() {
  const points = [], requests = [], createdMetrics = [];
  let roll = 0.1;
  let response = { status: 500, json: () => ({ error: { class: 'internal', message: 'mysql error' } }) };
  class Metric {
    constructor(name) { this.name = name; createdMetrics.push(name); }
    add(value, tags) { points.push({ metric: this.name, value, tags }); }
  }
  const context = vm.createContext({
    __ENV: { SCENARIO: 'typical-dbsat-4x-300', TARGET: 'http://offline.invalid' },
    Counter: Metric, Rate: Metric, check: () => true,
    Math: Object.assign(Object.create(Math), { random: () => roll }),
    crypto: { hmac: () => 'offline-signature' },
    encoding: { b64encode: text => Buffer.from(text).toString('base64url') },
    http: {
      get(url, params) { requests.push({ url, params }); return response; },
      post(url, body, params) { requests.push({ url, body, params }); return response; },
    },
  });
  vm.runInContext(executable(read('load/lib/common.js')), context);
  return { points, requests, createdMetrics, context,
    roll(value) { roll = value; },
    response(value) { response = value; },
    loadTypical() { vm.runInContext(executable(read('load/typical.js')), context); } };
}

test('common.js and recordErrorClass do not create or emit request_outcomes', () => {
  const f = fixture();
  assert.ok(!f.createdMetrics.includes('request_outcomes'));
  assert.equal(f.context.recordErrorClass({ status: 500, json: () => ({
    error: { class: 'internal', message: 'mysql error' },
  }) }), 'internal');
  assert.ok(f.points.every(p => p.metric !== 'request_outcomes'));
  assert.equal(f.points.filter(p => p.metric === 'errors_by_class').length, 1);
  assert.equal(f.points.filter(p => p.metric === 'classified_error_rate').length, 1);
});

test('all five typical request branches record 500/internal per request without thresholds', () => {
  const f = fixture(); f.loadTypical();
  for (const value of [0.1, 0.6, 0.8, 0.9, 0.995]) {
    f.roll(value); f.context.scenario();
  }
  assert.equal(f.requests.length, 5);
  const outcomes = f.points.filter(p => p.metric === 'request_outcomes');
  assert.deepEqual(outcomes.map(p => p.tags.name), [
    'GET /api/articles', 'GET /api/articles/:slug', 'GET /api/profiles/:username',
    'POST /api/articles/:slug/comments', 'POST /api/users/login',
  ]);
  assert.ok(outcomes.every(p => p.value === 1 && p.tags.http_status === '500' && p.tags.error_class === 'internal'));
  assert.equal(f.points.filter(p => p.metric === 'errors_by_class').length, 5);
  assert.equal(vm.runInContext('options.thresholds', f.context), undefined);
});

test('request_outcomes uses exported extractErrorClass, including explicit unknowns and successes', () => {
  const f = fixture(); f.loadTypical();
  const cases = [
    { status: 500, body: { error: { class: 'internal' } }, expected: 'internal' },
    { status: 504, body: { error: { class: 'db_timeout' } }, expected: 'db_timeout' },
    { status: 503, body: { error: { class: 'queue_full' } }, expected: 'queue_full' },
    { status: 500, body: null, expected: 'unclassified' },
    { status: 0, error_code: 1050, body: null, expected: 'unclassified' },
    { status: 200, body: {}, expected: 'none' },
  ];
  for (const row of cases) {
    f.response({ status: row.status, error_code: row.error_code, json() {
      if (row.body === null) throw new Error('non-JSON response');
      return row.body;
    } });
    f.context.scenario();
    const point = f.points.filter(p => p.metric === 'request_outcomes').at(-1);
    assert.equal(point.tags.http_status, String(row.status));
    assert.equal(point.tags.error_class, row.expected);
  }
  assert.equal(f.points.filter(p => p.metric === 'request_outcomes').length, cases.length);
});

test('lean and diagnostic scripts neither import typical.js nor emit request_outcomes', () => {
  for (const file of ['load/scenarios.js', 'load/diagnostics.js', 'load/lib/common.js']) {
    const source = read(file);
    assert.ok(!source.includes('request_outcomes'), file);
    assert.ok(!/from\s+['"].*typical\.js['"]/.test(source), file);
  }
});
