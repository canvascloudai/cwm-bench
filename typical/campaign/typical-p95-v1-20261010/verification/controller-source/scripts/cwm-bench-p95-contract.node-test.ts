import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { P95, p95Id, p95Environment, reverseLadder, generatorGate, budgetGate,
  PauseRequired, summaryGate, p95RunIdentity } from "./cwm-bench-p95-contract";
import { saveRaw } from "./cwm-bench-p95-raw";

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
  assert.throws(()=>budgetGate([],6,true),PauseRequired);
  assert.doesNotThrow(()=>budgetGate([],5,true));
  assert.throws(()=>budgetGate([{applyStartedAt:"2026-10-10T00:00:00Z",destroyedAt:"2026-10-10T18:00:00Z"}],0,false),PauseRequired);
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
