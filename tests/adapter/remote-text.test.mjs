import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readRemoteText, TEXT_CHUNK_BYTES } from '../../scripts/lib/adapter/remote-text.mjs';
import { collectPoolMetrics, parseSteady } from '../../scripts/lib/adapter/dbsat-collect.mjs';
import { localSsmText } from '../remote-text-helper.mjs';

const options = { instanceId: 'i-fixture', region: 'us-east-2', timeoutSeconds: 60,
  waitTimeoutMs: 60000, pollMs: 1, wait: async () => {} };

async function withPayload(text, callback) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cwm-remote-text-'));
  const file = path.join(dir, 'payload.txt');
  writeFileSync(file, text);
  try { await callback(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('large, incompressible snapshots survive SSM truncation and the actual redactor', async () => {
  const text = JSON.stringify({ histogram: randomBytes(180000).toString('base64') });
  await withPayload(text, async file => {
    const fixture = localSsmText();
    const result = await readRemoteText(fixture.runAws, { ...options, producer: `cat ${JSON.stringify(file)}` });
    assert.equal(result.stdout, text);
    assert(result.transfer.chunks > 2);
    assert.equal(result.transfer.verifiedBeforeParse, true);
    assert(fixture.outputLengths.every(n => n <= TEXT_CHUNK_BYTES * 2 + 100));
  });
});

test('short, redacted, and byte-corrupted chunks fail closed', async () => {
  for (const mutate of [
    text => text.startsWith('CWM_TEXT_HEX=') ? text.slice(0, -8) : text,
    text => text.startsWith('CWM_TEXT_HEX=') ? 'CWM_TEXT_HEX=[REDACTED_SECRET]\n' : text,
    text => text.replace(/^CWM_TEXT_HEX=./, 'CWM_TEXT_HEX=f'),
  ]) {
    await withPayload(JSON.stringify({ x: randomBytes(1000).toString('hex') }), async file => {
      const fixture = localSsmText({ mutate });
      await assert.rejects(readRemoteText(fixture.runAws, { ...options, producer: `cat ${JSON.stringify(file)}` }),
        /truncated|redacted|SHA256/);
    });
  }
});

test('large pool histories retain identity and exact window clipping', async () => {
  const body = { gitSha: 'fixture-sha', minutes: Array.from({ length: 120 }, (_, i) => ({
    minute: new Date(Date.parse('2026-10-13T00:00:00Z') + i * 60000).toISOString(),
    workers: Array.from({ length: 2 }, () => ({ pool: { waiting: 0, samples: randomBytes(300).toString('hex') } })),
  })) };
  assert(JSON.stringify(body).length > 24000);
  await withPayload(JSON.stringify(body), async file => {
    const fixture = localSsmText({ replace: text => text.replace(
      'curl -fsS --max-time 5 http://127.0.0.1:8080/api/metrics', `cat ${JSON.stringify(file)}`) });
    const result = await collectPoolMetrics(fixture.runAws, { appInstanceIds: ['i-a', 'i-b', 'i-c', 'i-d'] },
      options.region, { startTime: '2026-10-13T00:30:00Z', endTime: '2026-10-13T00:50:00Z' }, options);
    assert.equal(result.available, true);
    for (const node of result.nodes) {
      assert.equal(node.gitSha, body.gitSha);
      assert.deepEqual(node.minutes, body.minutes.slice(30, 50));
      assert.equal(node.transfer.verifiedBeforeParse, true);
    }
  });
});

test('retained real steady-P95 output survives transport without changing values', {
  skip: !process.env.CWM_TEXT_REAL_FIXTURE,
}, async () => {
  const text = readFileSync(process.env.CWM_TEXT_REAL_FIXTURE, 'utf8');
  assert(text.length > 24000);
  const framed = `---STEADY_JSON---\n${text}---END_STEADY_JSON---\nSTOPPED_JSON={"reason":"breach"}\n`;
  await withPayload(framed, async file => {
    const fixture = localSsmText();
    const result = await readRemoteText(fixture.runAws, { ...options, producer: `cat ${JSON.stringify(file)}` });
    assert.equal(result.stdout, framed);
    assert.deepEqual(parseSteady(result.stdout), { steady: JSON.parse(text), stopped: { reason: 'breach' } });
  });
});
