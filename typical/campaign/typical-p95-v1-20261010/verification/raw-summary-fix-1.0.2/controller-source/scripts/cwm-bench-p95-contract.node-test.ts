import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { P95, p95Id, p95Environment, reverseLadder, generatorGate, budgetGate,
  PauseRequired, summaryGate, p95RunIdentity, replacementUsage } from "./cwm-bench-p95-contract";
import { saveRaw, retainRungArtifacts } from "./cwm-bench-p95-raw";
import { stageTerraform } from "./cwm-bench-p95-staging";

test("external Terraform staging preserves relative app/load sources and repairs an unapplied layout", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p95-staging-test-"));
  try {
    const repo = path.join(dir, "cwm-bench"), tfdir = path.join(dir, "terraform");
    await fs.mkdir(path.join(repo, "terraform"), { recursive: true });
    await fs.writeFile(path.join(repo, "terraform/main.tf"), "# frozen fixture\n");
    for (const asset of ["app/src/server.js", "app/package.json", "app/seed/seed.sql",
      "load/scenarios.js", "load/diagnostics.js", "load/lib/common.js"]) {
      await fs.mkdir(path.dirname(path.join(repo, asset)), { recursive: true });
      await fs.writeFile(path.join(repo, asset), `frozen:${asset}\n`);
    }
    await fs.cp(path.join(repo, "terraform"), tfdir, { recursive: true });
    const first = await stageTerraform(repo, tfdir);
    assert.equal(first.length, 6); assert.ok(first.every(a => a.unchanged));
    assert.deepEqual(await stageTerraform(repo, tfdir), first);
    assert.equal(await fs.readFile(path.join(repo, "terraform/main.tf"), "utf8"), "# frozen fixture\n");
    await assert.rejects(fs.stat(path.join(repo, "terraform/zz-p95-backend.tf")));
    await fs.unlink(path.join(dir, "app"));
    await fs.mkdir(path.join(dir, "app"));
    await assert.rejects(stageTerraform(repo, tfdir), /does not point to the pinned checkout/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("pin, Latin square, reverse ladder, clean environment and actual-day letter ids", () => {
  assert.equal(P95.version, "1.6.1"); assert.deepEqual(P95.order, [[1,2,3],[2,3,1],[3,1,2]]);
  assert.equal(p95Id(2, 2, new Date("2026-10-12T00:00:00Z"), "a"), "typical-p95-2x-r2a-20261012");
  const e = p95Environment({ CWM_RUN_ID: "stale", CWM_DURATION: "1m", CWM_FIT_CAMPAIGN_DATE: "old",
    CWM_LADDER: "100,200,300", TF_VAR_app_pool_size: "5", AWS_ACCESS_KEY_ID: "fixture" }, "case", "schema", "/tf");
  assert.equal(e.CWM_RUN_ID, undefined);assert.equal(e.CWM_DURATION, undefined);assert.equal(e.CWM_LADDER, undefined);
  assert.equal(e.TF_VAR_app_pool_size, undefined);assert.equal(e.CWM_MEASUREMENT_SHA, P95.revision);
});
test("live shared ladder driver runs once per rung, recollects separately and stops invalid apply", async () => {
  const runs: number[] = [], collections: string[] = [];
  await reverseLadder({ before:async()=>{},run:async r=>{runs.push(r);},
    collect:async(r,_p,a)=>{collections.push(`${r}-${a}`);return{retry:a===1};},
    preserve:async()=>{},gate:async()=>{} });
  assert.deepEqual(runs,[300,200,100]);assert.equal(collections.length,6);
  runs.length=0;
  await assert.rejects(reverseLadder({before:async()=>{},run:async r=>{runs.push(r);},
    collect:async()=>({retry:false}),preserve:async()=>{},gate:async()=>{throw new Error("invalid");}}));
  assert.deepEqual(runs,[300]);
});
test("generator uses 15-minute steady MEAN, whole-rung scheduled denominator and strict fallback", () => {
  const b={start:"2026-10-10T10:00:00Z",end:"2026-10-10T10:21:00Z",complete:true};
  const c:any={artifacts:{k6:{droppedIterations:1575,peakVus:399}},cloudwatch:{metrics:{generator_cpu:{datapoints:[
    {timestamp:"2026-10-10T10:01:00Z",average:100},
    {timestamp:"2026-10-10T10:05:00Z",average:90},
    {timestamp:"2026-10-10T10:06:00Z",average:50},
    {timestamp:"2026-10-10T10:20:00Z",average:100},
  ]}}}};
  assert.ok(generatorGate(c,b,300).valid);c.artifacts.k6.droppedIterations=1576;assert.ok(!generatorGate(c,b,300).valid);
  c.artifacts.k6.droppedIterations=0;c.cloudwatch.metrics={};assert.ok(generatorGate(c,b,300).valid);
  c.artifacts.k6.peakVus=400;assert.ok(!generatorGate(c,b,300).valid);
});
test("budget refuses seventh replacement or over-cap reservation without stopping the campaign", () => {
  const reservation = { n: 1, rep: 1, suffix: "a" };
  assert.equal(replacementUsage([], reservation), 1);
  assert.equal(replacementUsage([{ ...reservation, applyAttempted: true }], reservation), 1);
  assert.throws(()=>budgetGate([],6,true),PauseRequired);
  assert.doesNotThrow(()=>budgetGate([],5,true));
  assert.throws(()=>budgetGate([{applyStartedAt:"2026-10-10T00:00:00Z",destroyedAt:"2026-10-10T18:00:00Z"}],0,false),PauseRequired);
});
test("multiline summary parses only after actual gzip download/hash verification and before destroy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p95-multiline-test-"));
  try {
    const gz = gzipSync('{"type":"Point","metric":"http_req_duration","data":{"value":1}}\n');
    const sha = createHash("sha256").update(gz).digest("hex");
    const summary = { metrics: { http_req_duration: { values: { "p(95)": 12 } } } };
    const trace: string[] = [];
    const probe = `SUMMARY_BEGIN\n${JSON.stringify(summary, null, 2)}\nSUMMARY_END\nBYTES=${gz.length}\nSHA256=${sha}\n`;
    const result = await retainRungArtifacts(probe, dir, async (file, expected) => {
      trace.push("download");
      await saveRaw(Readable.from([gz]), file, expected);
      assert.deepEqual(await fs.readFile(file), gz); trace.push("hash-checked");
    }, text => { trace.push("parse"); return JSON.parse(text); });
    trace.push("destroy");
    assert.deepEqual(result.summary, summary);
    assert.deepEqual(trace, ["download", "hash-checked", "parse", "destroy"]);
    assert.equal(result.present, true);
    assert.equal(await fs.readFile(path.join(dir, "summary.json"), "utf8"), JSON.stringify(summary, null, 2));
    const legacy = await retainRungArtifacts(
      `SUMMARY=${JSON.stringify(summary, null, 2)}\nBYTES=${gz.length}\nSHA256=${sha}\n`,
      path.join(dir, "legacy-multiline"), (file, expected) => saveRaw(Readable.from([gz]), file, expected));
    assert.deepEqual(legacy.summary, summary);
    const invalidDir = path.join(dir, "invalid-summary");
    await assert.rejects(retainRungArtifacts(probe.replace(JSON.stringify(summary, null, 2), "{invalid"),
      invalidDir, (file, expected) => saveRaw(Readable.from([gz]), file, expected)), PauseRequired);
    assert.deepEqual(await fs.readFile(path.join(invalidDir, "k6.json.gz")), gz);
    let parsed = false;
    await assert.rejects(retainRungArtifacts(probe, path.join(dir, "bad-hash"),
      (file, expected) => saveRaw(Readable.from([gz]), file, { ...expected, sha256: "0".repeat(64) }),
      () => { parsed = true; return {}; }), PauseRequired);
    assert.equal(parsed, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("live ladder preserves verified raw before collector interpretation and destroys only afterward", async () => {
  const trace: string[] = [];
  await reverseLadder({
    before: async () => {}, run: async rate => { trace.push(`run:${rate}`); },
    preserve: async rate => { trace.push(`download-and-hash:${rate}`); },
    collect: async rate => { trace.push(`collect:${rate}`); return { retry: false }; },
    gate: async rate => { trace.push(`gate:${rate}`); },
  });
  trace.push("destroy");
  assert.deepEqual(trace, [300, 200, 100].flatMap(rate =>
    [`run:${rate}`, `download-and-hash:${rate}`, `collect:${rate}`, `gate:${rate}`]).concat("destroy"));
});
test("definition violation pauses, ladder identity cannot alias or reorder", () => {
  const c={latency:{p95Ms:10}};
  assert.doesNotThrow(()=>summaryGate({metrics:{http_req_duration:{values:{"p(95)":10}}}},c));
  assert.throws(()=>summaryGate({metrics:{http_req_duration:{values:{"p(95)":10}},
    "http_req_duration{phase:steady}":{}}},c),PauseRequired);
  assert.throws(()=>p95RunIdentity({ok:true,adapterVersion:"1.6.1",campaignId:"a",scenario:"b",runId:"c",
    ladder:[100,200,300],rung_pos:1,ladder_history:[100]},"a","b","c",1));
});
test("gzip download verifies exact bytes/hash/integrity, preserves adjacent summary and never overwrites", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"p95-raw-test-"));
  try {
    const gz=gzipSync('{"type":"Point","metric":"http_req_duration","data":{"value":1}}\n');
    const expected={bytes:gz.length,sha256:createHash("sha256").update(gz).digest("hex")};
    const file=path.join(dir,"rung/k6.json.gz");
    await saveRaw(Readable.from([gz]),file,expected);assert.deepEqual(await fs.readFile(file),gz);
    await assert.rejects(saveRaw(Readable.from([gz]),file,expected));
    await assert.rejects(saveRaw(Readable.from([gz]),path.join(dir,"bad.gz"),{...expected,sha256:"0".repeat(64)}));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
