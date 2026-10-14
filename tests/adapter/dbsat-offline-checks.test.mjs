// Offline checks #2805 (per-generator transfer metadata) and #2806 (240-min
// /api/metrics sizing). No AWS calls, no engine queries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { mergeSteady, collectPoolMetrics } from '../../scripts/lib/adapter/dbsat-collect.mjs';
import { MAX_TEXT_GZIP_BYTES } from '../../scripts/lib/adapter/remote-text.mjs';
import { localSsmText } from '../remote-text-helper.mjs';
import { buildMetricsBody } from '../fixtures/dbsat-metrics-sizing.mjs';

const MAX_TEXT_BYTES = 16 * 1024 * 1024;

function generator(id, n, p95, transfer) {
  return { present: true, n, steadyP95Ms: p95, droppedIterations: 0,
    logHistogram: { ratio: 1.01, buckets: { 400: Math.floor(n * 0.9), 460: n - Math.floor(n * 0.9) } },
    perMinute: [{ minuteUtc: '2026-10-14T00:00:00Z', n, requests: n, failed: 0, p95Ms: p95 }], transfer };
}

test('#2805 two-generator merge keeps each generator transfer metadata', () => {
  const t1 = { encoding: 'gzip-lowercase-hex', compressedBytes: 42526, uncompressedBytes: 168772,
    sha256: 'a'.repeat(64), chunks: 6, verifiedBeforeParse: true };
  const t2 = { encoding: 'gzip-lowercase-hex', compressedBytes: 40001, uncompressedBytes: 160002,
    sha256: 'b'.repeat(64), chunks: 6, verifiedBeforeParse: true };
  const merged = mergeSteady([generator('g1', 675000, 90, t1), generator('g2', 675000, 95, t2)]);
  assert.equal(merged.generators, 2);
  assert.deepEqual(merged.perGenerator.map((g) => g.transfer), [t1, t2]);
  for (const g of merged.perGenerator)
    for (const key of ['compressedBytes', 'uncompressedBytes', 'sha256', 'chunks', 'verifiedBeforeParse'])
      assert.ok(key in g.transfer, key);
  // A generator without transfer metadata stays visibly without it (no invention).
  const bare = mergeSteady([generator('g1', 10, 1, undefined), generator('g2', 10, 1, t2)]);
  assert.equal(bare.perGenerator[0].transfer, undefined);
});

test('#2806 240 dense minutes x 4 app nodes at 1500 RPS pass the real collector + redactor', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cwm-metrics-sizing-'));
  try {
    const files = [];
    for (let i = 0; i < 4; i++) {
      const body = buildMetricsBody({ minutes: 240, denseMinutes: 240, bucketsPerMinute: 512, seed: i + 1 });
      assert.equal(body.minutes.length, 240);
      const file = path.join(dir, `node${i}.json`);
      writeFileSync(file, JSON.stringify(body));
      files.push({ file, body });
    }
    let current = 0;
    const fixture = localSsmText({ replace: (cmd) => cmd.replace(
      'curl -fsS --max-time 5 http://127.0.0.1:8080/api/metrics', () => `cat ${JSON.stringify(files[current].file)}`) });
    const runAws = fixture.runAws;
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      current = i;
      const first = files[i].body.minutes[0].minute;
      const window = { startTime: first, endTime: new Date(Date.parse(first) + 241 * 60000).toISOString() };
      const result = await collectPoolMetrics(runAws, { appInstanceIds: [`i-offline-app${i + 1}`] }, 'us-east-2',
        window, { ssmPollMs: 1, wait: async () => {} });
      const node = result.nodes[0];
      assert.equal(node.available, true, node.error);
      assert.equal(node.minutes.length, 240);
      assert.ok(node.transfer.uncompressedBytes <= MAX_TEXT_BYTES);
      assert.ok(node.transfer.compressedBytes <= MAX_TEXT_GZIP_BYTES);
      assert.equal(node.transfer.verifiedBeforeParse, true);
      nodes.push(node.transfer);
    }
    assert.ok(fixture.outputLengths.every((n) => n <= 24000));
    console.log(JSON.stringify({ sizing: nodes.map(({ compressedBytes, uncompressedBytes, chunks }) =>
      ({ compressedBytes, uncompressedBytes, chunks })), maxSsmStdout: Math.max(...fixture.outputLengths) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#2806 headroom: 4 MB compressed cap binds before 16 MiB; recorded break point', () => {
  const at = (b) => {
    const text = JSON.stringify(buildMetricsBody({ bucketsPerMinute: b }));
    return { b, bytes: Buffer.byteLength(text), gz: gzipSync(text).length };
  };
  const spec = at(512);
  assert.ok(spec.gz * 8 < MAX_TEXT_GZIP_BYTES, 'spec worst case keeps >8x compressed headroom');
  const heavy = at(8192);
  assert.ok(heavy.bytes < MAX_TEXT_BYTES);
  assert.ok(heavy.gz > MAX_TEXT_GZIP_BYTES * 0.9, 'compressed cap is the binding limit');
});
