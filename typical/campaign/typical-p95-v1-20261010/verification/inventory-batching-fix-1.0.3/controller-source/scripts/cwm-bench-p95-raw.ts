import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Writable, type Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { HoldoutIO } from "./cwm-bench-holdout-io";
import { ScaleCloud } from "./cwm-bench-scale-cloud";
import { PauseRequired } from "./cwm-bench-p95-contract";

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function saveRaw(stream: Readable, file: string, expected: { bytes: number; sha256: string }): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await pipeline(stream, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
    if ((await fs.stat(partial)).size !== expected.bytes || await hashFile(partial) !== expected.sha256)
      throw new PauseRequired("Raw transfer integrity mismatch; ask Kevin");
    await pipeline(createReadStream(partial), createGunzip(), new Writable({ write(_c, _e, done) { done(); } }));
    const handle = await fs.open(partial, "r"); try { await handle.sync(); } finally { await handle.close(); }
    await fs.link(partial, file); // Never overwrite previous raw evidence.
  } finally { await fs.unlink(partial).catch(() => {}); }
}
export async function stagingFile(name: string): Promise<any> {
  const { Storage } = await import("@google-cloud/storage");
  const response = await fetch("http://127.0.0.1:1106/object-storage/default-bucket");
  if (!response.ok) throw new PauseRequired("Private transfer staging unavailable; ask Kevin");
  const { bucketId } = await response.json() as { bucketId: string };
  if (typeof bucketId !== "string" || !bucketId) throw new PauseRequired("Transfer bucket unavailable");
  // Same Replit-managed credential exchange as the installed official App Storage SDK.
  const storage = new Storage({ projectId: "", credentials: {
    type: "external_account", audience: "replit", subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token", universe_domain: "googleapis.com",
    credential_source: { url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" } },
  } as any });
  return storage.bucket(bucketId).file(name);
}
export async function remoteLong(io: HoldoutIO, cloud: ScaleCloud, repo: string, env: NodeJS.ProcessEnv,
  instance: string, commands: string[], out: string): Promise<any> {
  const { runRemoteShell } = await import(pathToFileURL(path.join(repo, "scripts/lib/adapter/aws.mjs")).href);
  let index = 0;
  const runAws = async (args: string[]) => {
    const file = path.join(out, `aws-${++index}.json`);
    const r = await io.command("aws", args, repo, env, file, 120_000);
    return { ...r, stderr: await fs.readFile(`${file}.stderr.txt`, "utf8") };
  };
  const result = await runRemoteShell(runAws, { instanceId: instance, region: "us-east-2", commands,
    timeoutSeconds: 900, waitTimeoutMs: 960_000, pollMs: 5000, throwOnFailure: true,
    wait: (ms: number) => io.wait(ms) });
  await io.json(path.join(out, "remote.json"), result);
  return result;
}

/** Shared live/offline path: retain and verify gzip before interpreting the summary. */
export async function retainRungArtifacts(probe: string, dest: string,
  downloadAndVerify: (file: string, expected: { bytes: number; sha256: string }) => Promise<void>,
  parseSummary: (text: string) => any = JSON.parse): Promise<{ bytes: number; summary: any; present: boolean }> {
  const sha256 = /^SHA256=([a-f0-9]{64})$/m.exec(probe)?.[1];
  const bytes = Number(/^BYTES=(\d+)$/m.exec(probe)?.[1]);
  if (!sha256 || !Number.isSafeInteger(bytes) || bytes <= 0) return { bytes: 0, summary: null, present: false };
  await downloadAndVerify(path.join(dest, "k6.json.gz"), { bytes, sha256 });
  const text = /^SUMMARY_BEGIN\r?\n([\s\S]*?)\r?\nSUMMARY_END(?:\r?\n|$)/m.exec(probe)?.[1] ??
    /^SUMMARY=([\s\S]*?)(?=^BYTES=\d+\r?$)/m.exec(probe)?.[1];
  if (!text) return { bytes, summary: null, present: true };
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const file = path.join(dest, "summary.json");
  try { await fs.writeFile(file, text, { flag: "wx", mode: 0o600 }); }
  catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    if (await fs.readFile(file, "utf8") !== text) throw new PauseRequired("Retained summary changed; ask Kevin");
  }
  let summary: any;
  try { summary = parseSummary(text); }
  catch { throw new PauseRequired("Raw gzip retained and verified; summary parsing failed; ask Kevin before a code fix"); }
  return { bytes, summary, present: true };
}

export async function downloadRung(io: HoldoutIO, cloud: ScaleCloud, s: any, env: NodeJS.ProcessEnv,
  instance: string, runId: string, key: string): Promise<{ bytes: number; summary: any; present: boolean }> {
  if (!/^[a-z0-9-]+$/.test(s.campaign) || !/^[a-z0-9-]+$/.test(runId)) throw new Error("Unsafe artifact identity");
  const dir = `/opt/cwm-bench/results/raw/${s.campaign}/${runId}`;
  const dest = path.join(s.out, "rungs", key);
  const probe = await cloud.remote(s.repo, env, instance, [[
    "set -euo pipefail", `DIR='${dir}'`,
    'if [ -f "$DIR/summary.json" ]; then printf "SUMMARY_BEGIN\\n"; cat "$DIR/summary.json"; printf "\\nSUMMARY_END\\n"; fi',
    'if [ -f "$DIR/k6.json.gz" ]; then',
    ' printf "BYTES=%s\\n" "$(stat -c %s "$DIR/k6.json.gz")"',
    ' printf "SHA256=%s\\n" "$(sha256sum "$DIR/k6.json.gz" | cut -d " " -f 1)"',
    'fi',
  ].join("\n")], path.join(s.out, `raw-probe-${key}-${Date.now()}`));
  return retainRungArtifacts(probe.stdout, dest, async (target, { bytes, sha256 }) => {
  if (await fs.stat(target).then(() => true, () => false)) {
    if ((await fs.stat(target)).size !== bytes || await hashFile(target) !== sha256)
      throw new PauseRequired("Previously downloaded raw hash mismatch");
    return;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const objectName = `benchmark-transfer/${s.campaign}/${runId}/${randomUUID()}.gz`;
    const object = await stagingFile(objectName);
    try {
      const [uri] = await object.createResumableUpload({ metadata: { contentType: "application/octet-stream" },
        preconditionOpts: { ifGenerationMatch: 0 } });
      io.secrets.push(uri); // Resumable URI is a bearer credential; never save it in evidence.
      await remoteLong(io, cloud, s.repo, env, instance, [[
        "set -euo pipefail",
        `curl --fail --silent --show-error --connect-timeout 20 --max-time 840 --request PUT ` +
        `--header 'Content-Type: application/octet-stream' --upload-file '${dir}/k6.json.gz' '${uri}' >/dev/null`,
        "printf 'RAW_UPLOAD_COMPLETE\\n'",
      ].join("\n")], path.join(s.out, `raw-upload-${key}-attempt${attempt}-${Date.now()}`));
      await saveRaw(object.createReadStream({ decompress: false }), target, { bytes, sha256 });
      await io.json(path.join(dest, "download-verification.json"), { bytes, sha256, gzipIntegrityVerified: true,
        verifiedBeforeSummaryParse: true, source: "generator", transferAttempt: attempt, at: new Date().toISOString() });
      // A staging deletion failure cannot invalidate a successfully retained measurement.
      try { await object.delete(); }
      catch { await io.json(path.join(dest, "staging-cleanup-pending.json"), { objectName, localRawVerified: true }); }
      return;
    } catch {
      await io.json(path.join(s.out, `raw-transfer-${key}-attempt${attempt}-failure.json`),
        { at: new Date().toISOString(), objectName, evidencePreserved: true, noRungRetry: true });
      if (attempt === 2) throw new PauseRequired("Raw download failed twice; ask Kevin before a wiring fix");
    }
  }
  throw new PauseRequired("Raw transfer unavailable");
  });
}
