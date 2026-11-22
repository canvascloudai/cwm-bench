import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { launchCommand } from '../../scripts/lib/adapter/oci-commands.mjs';

const parser = fileURLToPath(new URL('../../scripts/lib/adapter/oci-raw.py', import.meta.url));
const legacyPython = `
import datetime, runpy, sys
class LegacyMeta(type):
    def __getattribute__(cls, field):
        if field == "fromisoformat":
            raise AttributeError("fromisoformat is unavailable in Python 3.6")
        return super().__getattribute__(field)
class LegacyDateTime(datetime.datetime, metaclass=LegacyMeta):
    pass
datetime.datetime = LegacyDateTime
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;

test('real k6 v0.54 formats on a Python runtime without fromisoformat', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-raw-v054-'));
  try {
    const marker = { campaignId: 'fixture', runId: 'rung-10', scenario: 'oci-holdout-10',
      startedAt: '2026-11-20T00:00:00.283841+00:00', endedAt: '2026-11-20T00:20:02.836278+00:00', exitCode: 0 };
    const points = [];
    const request = (time, ms) => {
      for (const [metric, value] of [['http_req_duration', ms], ['http_reqs', 1], ['http_req_failed', 0]]) {
        points.push(JSON.stringify({ type: 'Point', metric, data: { value, time,
          tags: { campaign_id: marker.campaignId, run_id: marker.runId, phase: 'steady', status: '200' } } }));
      }
    };
    request('2026-11-20T00:05:00.283840999Z', 100); // exactly 1 ns before steady
    request('2026-11-20T00:05:00.283841001Z', 4);
    request('2026-11-20T00:20:00.283841001Z', 101); // grace: whole-run only
    const raw = path.join(dir, 'k6.json.gz'), completion = path.join(dir, 'complete.json');
    await writeFile(raw, gzipSync(points.join('\n') + '\n'));
    await writeFile(completion, JSON.stringify(marker));
    const summary = path.join(dir, 'summary.json');
    const execute = () => spawnSync('python3', ['-c', legacyPython, parser, raw, completion], { encoding: 'utf8' });
    for (const http_reqs of [{ type: 'counter', contains: 'default', values: { count: 3, rate: 3 / 1200 } }, { count: 3, rate: 3 / 1200 }]) {
      await writeFile(summary, JSON.stringify({ metrics: { http_reqs } }));
      const result = execute();
      assert.equal(result.status, 0, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.steady.rawSamples, 1);
      assert.equal(data.steady.p50Ms, 4);
      assert.equal(data.whole.rawSamples, 3);
      assert.equal(data.summaryCountVerified, true);
      assert.equal(data.rawSha256, createHash('sha256').update(await readFile(raw)).digest('hex'));
    }
    for (const [http_reqs, reason] of [
      [{ values: { count: 4 } }, 'SUMMARY_HTTP_REQS_MISMATCH'],
      [{ values: { count: 'untrusted-string' } }, 'SUMMARY_HTTP_REQS_COUNT'],
    ]) {
      await writeFile(summary, JSON.stringify({ metrics: { http_reqs } }));
      const result = execute();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), `OCI_RAW_EVIDENCE_INVALID:${reason}`);
    }
    await writeFile(summary, JSON.stringify({ metrics: { http_reqs: { count: 3 }, dropped_iterations: { count: 1 } } }));
    assert.equal(execute().stderr.trim(), 'OCI_RAW_EVIDENCE_INVALID:SUMMARY_DROPPED_ITERATIONS_MISMATCH');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the frozen handleSummary is OCI’s sole summary writer', () => {
  const cmd = launchCommand({ target: 'http://192.0.2.1', measurement_sha: 'a'.repeat(40) },
    { campaignId: 'fixture', runId: 'rung-10', scenario: 'oci-holdout-10' });
  assert.doesNotMatch(cmd, /--summary-export/);
  assert.match(cmd, /--out json=k6\.json/);
});
