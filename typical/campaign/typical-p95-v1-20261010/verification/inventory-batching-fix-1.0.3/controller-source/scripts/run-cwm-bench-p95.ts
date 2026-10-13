#!/usr/bin/env -S npx tsx
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { HoldoutIO } from "./cwm-bench-holdout-io";
import { withProcessLock } from "./cwm-bench-process-lock";
import { emptyInitialState, utcStamp } from "./cwm-bench-holdout-contract";
import { ScaleCloud, scaleCredentials } from "./cwm-bench-scale-cloud";
import { P95Cloud } from "./cwm-bench-p95-cloud";
import { parseRunBounds } from "./cwm-bench-scale-contract";
import { exactMysql80Version } from "./cwm-bench-scale-evidence";
import { downloadRung } from "./cwm-bench-p95-raw";
import { stageTerraform } from "./cwm-bench-p95-staging";
import { P95, PauseRequired, InvalidApply, p95Id, p95Variables, p95Environment,
  p95Capability, p95Ready, p95Topology, p95RunIdentity, p95CollectGate, summaryGate,
  needsRecollect, generatorGate, reverseLadder, budgetGate, spendUpperBound, cloudwatchGaps,
  replacementUsage, type ReplacementReservation, type Bounds } from "./cwm-bench-p95-contract";

const ROOT = path.resolve(".local/private-cwm-p95");
const TF = path.resolve(".local/private-cwm-scale/tools/terraform");
const OLD_LOCK = path.resolve(".local/private-cwm-holdouts/.runner.lock");
const OLD_LOCK_HASH = "1c8ee08ef9a17a249ccfda5122ddbc6687f89413bf2e2b7c7a5101a8fd3e3df5";
const OLD_ROOTS = [
  path.resolve(".local/private-cwm-holdouts/typical-holdouts-v1-20261006/out"),
  path.resolve(".local/private-cwm-scale/typical-scale-v1-20261006/out"),
];
const SOURCE_FILES = [
  "scripts/run-cwm-bench-p95.ts", "scripts/cwm-bench-p95-contract.ts", "scripts/cwm-bench-p95-raw.ts",
  "scripts/cwm-bench-p95-contract.node-test.ts", "scripts/cwm-bench-holdout-io.ts",
  "scripts/cwm-bench-p95-provenance-dry-run.ts",
  "scripts/cwm-bench-p95-staging.ts",
  "scripts/cwm-bench-p95-cloud.ts",
  "scripts/cwm-bench-process-lock.ts", "scripts/cwm-bench-holdout-contract.ts",
  "scripts/cwm-bench-typical-contract.ts", "scripts/cwm-bench-scale-contract.ts",
  "scripts/cwm-bench-scale-cloud.ts", "scripts/cwm-bench-scale-cleanup.ts",
  "scripts/cwm-bench-holdout-cleanup.ts", "scripts/cwm-bench-scale-evidence.ts",
];
type Slot = {
  campaign: string; n: number; rep: number; suffix: string; repo: string; tfdir: string; out: string; schema: string;
  applyAttempted: boolean; applied: boolean; destroyed: boolean; delayed: boolean; valid?: boolean;
  invalidReason?: string; pauseReason?: string; applyStartedAt?: string; destroyedAt?: string;
  exportedBytes: number; engineVersion?: string; rungs: any[];
};
type Journal = {
  parent: string; revision: string; controllerHash: string; ami?: string; account?: string;
  slots: Slot[]; days: Record<string, string>; paused?: string; archives?: string[]; finishedAt?: string;
  nextSession?: number; nextSessionAt?: string; missingRawApplies: string[];
  lastEvent?: { at: string; text: string }; spendGuard?: any;
  reservedReplacement?: ReplacementReservation;
};
const io = new HoldoutIO();
let root: string, j: Journal, base: NodeJS.ProcessEnv, cloud: ScaleCloud;
const exists = async (p: string) => fs.stat(p).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
const read = async (p: string) => JSON.parse(await fs.readFile(p, "utf8"));
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
async function controllerSources() {
  const files = await Promise.all(SOURCE_FILES.map(async file => ({ file, bytes: await fs.readFile(file) })));
  return { files, sha256: hash(files.map(f => `${f.file}\0${hash(f.bytes)}`).join("\n")) };
}
async function persist() {
  j.spendGuard = { conservativeUpperBoundUsd: spendUpperBound(j.slots), actualBillingClaim: false,
    capUsd: P95.budgetUsd, replacementsUsed: replacementUsage(j.slots, j.reservedReplacement),
    cleanupReserveUsd: P95.cleanupReserveUsd };
  await io.state(path.join(root, "runner-state.json"), j);
}
async function event(text: string) {
  j.lastEvent = { at: new Date().toISOString(), text }; await persist(); console.log(text);
}
function applyBudget(n: number, rep: number, suffix: string) {
  const r = j.reservedReplacement;
  const pending = r && r.n === n && r.rep === rep && r.suffix === suffix &&
    !j.slots.some(s => s.n === n && s.rep === rep && s.suffix === suffix && s.applyAttempted);
  budgetGate(j.slots, replacementUsage(j.slots, r) - (pending ? 1 : 0), Boolean(suffix));
}
function env(s: Slot) { return p95Environment(base, s.campaign, s.schema, s.tfdir); }
async function command(s: Slot, cmd: string, args: string[], file: string, e = env(s), cwd = s.repo) {
  return io.command(cmd, args, cwd, e, path.join(s.out, file));
}
async function tf(s: Slot, args: string[], file: string) { return command(s, TF, args, file, env(s), s.tfdir); }
async function adapter(s: Slot, action: string, file: string, scenario?: string, e = env(s)) {
  return command(s, "node", ["scripts/worker-adapter.mjs", action,
    ...(scenario ? ["--scenario", scenario] : []), "--json"], file, e);
}
function checked(r: any, label: string) {
  if (r.code !== 0) throw new InvalidApply(`${label} failed; original command evidence retained`);
  return r.value;
}
async function guard(s: Slot) {
  if (hash(await fs.readFile(OLD_LOCK)) !== OLD_LOCK_HASH) throw new PauseRequired("Historical lock changed; ask Kevin");
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let args: string[];
    try { args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0"); }
    catch (e: any) { if (["ENOENT", "ESRCH"].includes(e.code)) continue; throw e; }
    if (args.some(a => !/\s/.test(a) && /(?:^|\/)(run-cwm-bench-(typical|holdouts|scale)|recheck-cwm-bench-scale-cleanup)\.ts$/.test(a)))
      throw new PauseRequired("Another benchmark controller is active; ask Kevin");
  }
  const old = await read(path.resolve(".local/private-cwm-scale/typical-scale-v1-20261006/runner-state.json"));
  if (!old.finishedAt || old.slots.some((s: any) => !s.destroyed)) throw new PauseRequired("Previous scale campaign not clean");
  const ids = ["typical-v1-20260927c", "typical-later-day-20261006", "typical-second-region-20261006",
    ...old.slots.map((s: any) => s.campaign), ...j.slots.filter(s => s.destroyed).map(s => s.campaign)];
  const out = path.join(s.out, "cleanup", `preapply-${Date.now()}`);
  await cloud.verifyCleanup(ids, [...OLD_ROOTS, path.join(root, "out")], out, j.account!);
  for (const region of ["us-east-2", "us-west-2"]) {
    const v = await cloud.aws(region, ["ec2", "describe-instances", "--filters",
      "Name=tag:Project,Values=cwm-bench", "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped"],
      path.join(out, `all-project-${region}.json`));
    if (!Array.isArray(v.Reservations) || v.Reservations.some((r: any) => r.Instances.length))
      throw new PauseRequired("Another live benchmark blocks provisioning");
  }
  await io.json(path.join(out, "historical-lock.json"), { sha256: OLD_LOCK_HASH, untouched: true });
}
async function setup(s: Slot) {
  await fs.mkdir(s.out, { recursive: true, mode: 0o700 });
  if (!await exists(s.repo)) {
    checked(await command(s, "git", ["clone", P95.repository, s.repo], "git-clone.log", base, root), "Clone");
    checked(await command(s, "git", ["checkout", "--detach", P95.revision], "git-checkout.log"), "Checkout");
  }
  const rev = await command(s, "git", ["rev-parse", "HEAD"], `git-sha-${Date.now()}.txt`);
  if (rev.code !== 0 || rev.stdout.trim() !== P95.revision) throw new PauseRequired("Checkout SHA mismatch");
  const diff = await command(s, "git", ["diff", "--exit-code"], `git-frozen-package-${Date.now()}.txt`);
  if (diff.code !== 0) throw new PauseRequired("Frozen measurement package changed");
  for (const f of ["typical/p95-v1/PREREGISTRATION.md", "typical/p95-v1/predictions/engine-baseline/predictions.json"])
    if (!await exists(path.join(s.repo, f))) throw new PauseRequired("Frozen evidence package missing");
  // Terraform work and backend wiring are OUTSIDE the immutable cwm-bench checkout.
  const assets = await stageTerraform(s.repo, s.tfdir);
  await io.json(path.join(s.out, `terraform-source-layout-${Date.now()}.json`), {
    assets, frozenMeasurementSha: P95.revision, outsideBenchmarkRepo: true });
  const cap = checked(await adapter(s, "wait-ready", `00-capability-${Date.now()}.json`), "Capability");
  if (!p95Capability(cap)) throw new PauseRequired(`Adapter ${P95.version} capabilities missing; ask Kevin before a fix`);
  checked(await tf(s, ["init", "-input=false", "-reconfigure"], `terraform-init-${Date.now()}.log`), "Init");
  checked(await tf(s, ["validate", "-json"], `terraform-validate-${Date.now()}.json`), "Local Terraform validation");
}
async function provision(s: Slot) {
  await guard(s); await setup(s);
  const stateName = `terraform-preapply-state-${Date.now()}.txt`;
  const state = await tf(s, ["state", "list"], stateName);
  if (!emptyInitialState(state.code, state.stdout, await fs.readFile(path.join(s.out, `${stateName}.stderr.txt`), "utf8")))
    throw new PauseRequired("Fresh apply state not empty; no apply authorized");
  applyBudget(s.n, s.rep, s.suffix);
  const plan = path.join(s.tfdir, "private-p95.tfplan");
  checked(await tf(s, ["plan", "-input=false", ...p95Variables(s.n, s.campaign, j.ami!), `-out=${plan}`],
    `terraform-plan-${Date.now()}.log`), "Plan");
  const at = new Date().toISOString();
  if (s.campaign.slice(-8) !== utcStamp(new Date(at))) throw new PauseRequired("UTC day rolled during preflight; ask Kevin");
  const day = at.slice(0, 10), previous = j.days[String(s.rep)];
  if (previous && previous !== day && !s.suffix) throw new PauseRequired("Daily originals crossed UTC day; ask Kevin");
  if (s.rep === 1 && !j.slots.some(x => x.applyAttempted) && j.parent.slice(-8) !== utcStamp(new Date(at)))
    throw new PauseRequired("Parent date differs from first actual apply; ask Kevin");
  if (!previous && !s.suffix) {
    if (Object.entries(j.days).some(([rep, date]) => Number(rep) !== s.rep && date === day))
      throw new PauseRequired("Sessions must start on separate UTC days");
    j.days[String(s.rep)] = day;
  }
  s.applyAttempted = true; s.applyStartedAt = at; await persist();
  await io.json(path.join(s.out, "01-apply-started.json"), { at, ami: j.ami,
    measurement_sha: P95.revision, controllerHash: j.controllerHash });
  await event(`APPLY_STARTED ${s.campaign} ami=${j.ami}`);
  checked(await tf(s, ["apply", "-input=false", "-auto-approve", plan], "terraform-apply.log"), "Apply");
  s.applied = true; await persist();
  await io.json(path.join(s.out, "01-apply-finished.json"), { at: new Date().toISOString() });
}
async function ready(s: Slot) {
  const outputs = checked(await tf(s, ["output", "-json"], `terraform-outputs-${Date.now()}.json`), "Outputs");
  await io.json(path.join(s.out, "01-terraform-outputs.json"), outputs);
  p95Topology(outputs, s.n, j.ami!);
  p95Ready(checked(await adapter(s, "wait-ready", "02-wait-ready.json"), "Wait-ready"), s.n);
  const db = await cloud.aws(P95.region, ["rds", "describe-db-instances", "--db-instance-identifier",
    outputs.rds_identifier.value], path.join(s.out, "03-rds-engine-version.json"));
  s.engineVersion = exactMysql80Version(db); await persist();
  await event(`READY_CONFIRMED ${s.campaign} adapter=${P95.version} apps=${s.n} profile=typical workers=2 SHA=${P95.revision}`);
  return outputs;
}
async function ladder(s: Slot, outputs: any) {
  let active: { scenario: string; runId: string; bounds?: Bounds; collect?: any; raw?: any; record: any };
  await reverseLadder({
    before: async (rate, pos) => {
      const scenario = `typical-p95-${s.n}x-${rate}`, runId = `${scenario}-r${s.rep}${s.suffix}`;
      const record = { scenario, runId, rungPos: pos, startedAt: new Date().toISOString(), noRungRetry: true };
      active = { scenario, runId, record };
      p95Ready(checked(await adapter(s, "wait-ready", `09-${scenario}.wait-ready.json`), "Rung readiness"), s.n);
      await io.json(path.join(s.out, `10-${scenario}.started.json`), record);
      s.rungs.push(record); await persist();
    },
    run: async (_rate, pos) => {
      const e = { ...env(s), CWM_SCENARIO: active.scenario, CWM_RUN_ID: active.runId };
      await event(`RUN_STARTED ${s.campaign} ${active.scenario}`);
      const run = await adapter(s, "run", `10-${active.scenario}.run.json`, active.scenario, e);
      p95RunIdentity(run.value, s.campaign, active.scenario, active.runId, pos);
      const dir = `/opt/cwm-bench/results/raw/${s.campaign}/${active.runId}`;
      const captured = await cloud.remote(s.repo, e, outputs.generator_instance_id.value, [[
        "set -euo pipefail", `DIR='${dir}'`, 'printf "identity=%s\\n" "$(cat "$DIR/identity.json")"',
        'printf "started_at=%s\\n" "$(cat "$DIR/started_at")"',
        'printf "completed_at=%s\\n" "$(cat "$DIR/completed_at")"',
        'printf "exit_code=%s\\n" "$(cat "$DIR/exit.code")"',
      ].join("\n")], path.join(s.out, `bounds-${active.scenario}`));
      const id = JSON.parse(/^identity=(.+)$/m.exec(captured.stdout)?.[1] ?? "null");
      if (id?.campaignId !== s.campaign || id.scenario !== active.scenario || id.runId !== active.runId)
        throw new InvalidApply("Generator marker identity mismatch");
      active.bounds = parseRunBounds(captured.stdout);
      if (!active.bounds.complete) throw new InvalidApply("Incomplete rung");
      Object.assign(active.record, { bounds: active.bounds }); await persist();
    },
    collect: async (_rate, _pos, attempt) => {
      if (attempt > 1) await io.wait(5 * 60_000);
      const e = { ...env(s), CWM_SCENARIO: active.scenario, CWM_RUN_ID: active.runId,
        CWM_RUN_STARTED_AT: active.bounds!.start, CWM_RUN_ENDED_AT: active.bounds!.end };
      const file = `11-${active.scenario}.collect${attempt === 1 ? "" : `-attempt${attempt}`}.json`;
      const c = await adapter(s, "collect", file, active.scenario, e);
      active.collect = c.value; Object.assign(active.record, { collectAttempt: attempt }); await persist();
      return { retry: needsRecollect(c.value, active.bounds!, attempt) };
    },
    preserve: async () => {
      active.raw = await downloadRung(io, cloud, s,
        { ...env(s), CWM_RUN_ID: active.runId, CWM_SCENARIO: active.scenario },
        outputs.generator_instance_id.value, active.runId, active.scenario);
      s.exportedBytes += active.raw.bytes; await persist();
      if (!active.raw.present && !j.missingRawApplies.includes(s.campaign)) {
        j.missingRawApplies.push(s.campaign); await persist();
      }
      if (!active.raw.present) throw new PauseRequired("Required generator gzip unavailable; ask Kevin before a wiring fix");
    },
    gate: async (rate, pos) => {
      p95CollectGate(active.collect, active.bounds!, s.n, j.ami!, s.campaign, active.scenario, active.runId, pos);
      summaryGate(active.raw.summary, active.collect);
      const g = generatorGate(active.collect, active.bounds!, rate);
      Object.assign(active.record, { generatorValid: g.valid, invalidReason: g.reason,
        rawDownloaded: true, cloudwatchDescriptiveGaps: cloudwatchGaps(active.collect, active.bounds!), completed: true });
      await persist(); await io.json(path.join(s.out, `12-${active.scenario}.gate.json`), active.record);
      await event(`RUNG_SAVED ${s.campaign} ${active.scenario}`);
      if (!g.valid) throw new InvalidApply(g.reason!);
    },
  });
}
async function destroy(s: Slot) {
  if (!s.applyAttempted || s.destroyed) return;
  io.cleaning = true; await event(`DESTROY_STARTED ${s.campaign}`);
  checked(await tf(s, ["init", "-input=false", "-reconfigure"], `destroy-init-${Date.now()}.log`), "Destroy init");
  const vars = p95Variables(s.n, s.campaign, j.ami!);
  const result = await tf(s, ["destroy", "-input=false", "-auto-approve", ...vars], `terraform-destroy-${Date.now()}.log`);
  if (result.code !== 0)
    checked(await command(s, "bash", ["scripts/terraform-destroy-retry.sh", ...vars],
      `destroy-retry-${Date.now()}.log`, { ...env(s), CWM_TF_DIR: s.tfdir }), "Destroy retry");
  const state = await tf(s, ["state", "list"], `terraform-postdestroy-state-${Date.now()}.txt`);
  if (state.code !== 0 || state.stdout.trim()) throw new PauseRequired("Destroy not confirmed empty; ask Kevin urgently");
  s.destroyedAt = new Date().toISOString(); await persist();
  await io.json(path.join(s.out, `93-destroy-finished-${Date.now()}.json`), { at: s.destroyedAt });
  await cloud.verifyCleanup([s.campaign], [s.out],
    path.join(s.out, "cleanup", `immediate-${Date.now()}`), j.account!);
  s.destroyed = true; await persist(); await event(`DESTROY_FINISHED ${s.campaign}`);
}
async function delayed(s: Slot) {
  if (!s.destroyed || s.delayed) return;
  io.cleaning = true;
  await io.wait(Math.max(0, Date.parse(s.destroyedAt!) + 900_000 - Date.now()));
  await cloud.verifyCleanup([s.campaign], [s.out],
    path.join(s.out, "cleanup", `delayed-${Date.now()}`), j.account!);
  s.delayed = true; await persist(); io.cleaning = false;
  await event(`DELAYED_CLEANUP_CONFIRMED ${s.campaign}`);
}
async function applyCell(n: number, rep: number, suffix: string) {
  applyBudget(n, rep, suffix);
  const campaign = p95Id(n, rep, new Date(), suffix);
  const unused = j.slots.find(s => s.campaign === campaign);
  if (unused?.applyAttempted) throw new PauseRequired("Apply identity already used; ask Kevin");
  const work = path.join(root, "work", campaign);
  const s: Slot = unused ?? { campaign, n, rep, suffix, repo: path.join(work, "cwm-bench"), tfdir: path.join(work, "terraform"),
    out: path.join(root, "out", campaign), schema: `p95_${hash(campaign).slice(0, 24)}`,
    applyAttempted: false, applied: false, destroyed: false, delayed: false, exportedBytes: 0, rungs: [] };
  if (!unused) j.slots.push(s);
  await persist();
  try { await provision(s); const outputs = await ready(s); await ladder(s, outputs); s.valid = true; await persist(); }
  catch (e) {
    const reason = io.redact(e instanceof Error ? e.message : "Apply failed");
    if (!s.applyAttempted || !(e instanceof InvalidApply) || io.interrupted) {
      if (s.applyAttempted) {
        s.valid = false; s.invalidReason = reason; await persist();
        await io.json(path.join(s.out, `controller-failure-pause-${Date.now()}.json`), {
          reason, invalidApply: true, excludedFromScoring: true, creatorApprovalRequired: true, noRungRetry: true });
      }
      s.pauseReason = reason; throw new PauseRequired(reason);
    }
    s.valid = false; s.invalidReason = reason; await persist();
    await io.json(path.join(s.out, "apply-invalidation.json"), { at: new Date().toISOString(), reason,
      wholeApplyReplacement: true, noRungRetry: true });
    await event(`APPLY_INVALID ${campaign} reason=${reason}`);
  } finally {
    if (s.applyAttempted) { await destroy(s); await delayed(s); }
  }
}
function valid(n: number, rep: number) { return j.slots.some(s => s.n === n && s.rep === rep && s.valid && s.delayed); }
async function replacements(rep: number) {
  for (const n of P95.order[rep - 1]) {
    while (!valid(n, rep)) {
      const prior = j.slots.filter(s => s.n === n && s.rep === rep && s.applyAttempted);
      if (!prior.length) break;
      const last = prior.at(-1)!;
      if (last.suffix && last.invalidReason?.startsWith("generator-"))
        throw new PauseRequired("Replacement also generator-invalid; prereg permits one such replacement; ask Kevin");
      if (!last.destroyed || !last.delayed) throw new PauseRequired("Replacement blocked by incomplete cleanup");
      await applyCell(n, rep, String.fromCharCode(96 + prior.length));
    }
  }
}
async function executeSession(rep: number) {
  // Previous-day replacements are first; today's replacements follow all three originals.
  for (let r = 1; r < rep; r++) await replacements(r);
  if (rep > 1) {
    const previous = j.slots.find(s => s.rep === rep - 1 && !s.suffix && s.applyStartedAt);
    if (!previous) throw new PauseRequired("Previous session has not run");
    const due = Date.parse(previous.applyStartedAt!) + 24 * 3600_000;
    if (Date.now() < due) throw new PauseRequired(`Next session not due before ${new Date(due).toISOString()}`);
  }
  for (const n of P95.order[rep - 1]) {
    if (j.slots.some(s => s.n === n && s.rep === rep && s.applyAttempted)) continue;
    await applyCell(n, rep, "");
  }
  await replacements(rep);
  await event(`SESSION_FINISHED rep=${rep} no-live-stacks=true`);
  if (rep < 3) {
    j.nextSession = rep + 1;
    j.nextSessionAt = new Date(Date.parse(j.slots.find(s => s.rep === rep && !s.suffix)!.applyStartedAt!) + 24 * 3600_000).toISOString();
    await persist(); await event(`SESSION_PAUSED next=${j.nextSession} due=${j.nextSessionAt}`); return;
  }
  if (j.slots.filter(s => s.valid).length !== 9) throw new PauseRequired("Not all nine valid applies available; ask Kevin");
  j.finishedAt = new Date().toISOString(); await persist();
  const note = [
    "# Raw typical-p95-v1 execution", `Parent: ${j.parent}`, `Measurement SHA: ${P95.revision}`,
    `Adapter: ${P95.version}`, `Controller: ${P95.controllerVersion}; SHA256 ${j.controllerHash}`,
    `Pinned AL2023 AMI: ${j.ami}`, `UTC session days: ${JSON.stringify(j.days)}`, `Finished UTC: ${j.finishedAt}`,
    "No scoring, engine queries, metric commentary, thresholds, retuning, or coefficient changes.",
    "Reverse ladders 300 → 200 → 100; no rung retries. Whole-apply replacements and failed attempts are retained.",
    "All resources destroyed; immediate and at-least-15-minute checks confirmed in both regions.",
    "Spend guard is a conservative upper bound, not actual billed spend; its frozen basis is in verification/.",
    "| Apply | Start UTC | Exact RDS EngineVersion | Valid | Replacement |",
    "| --- | --- | --- | --- | --- |",
    ...j.slots.map(s => `| ${s.campaign} | ${s.applyStartedAt ?? "not applied"} | ${s.engineVersion ?? "unavailable"} | ${s.valid === true} | ${s.suffix || "none"} |`),
    "See per-apply rungs/ for summary.json, k6.json.gz and download hashes. All operational failures and cleanup proofs are retained.",
  ].join("\n") + "\n";
  await io.text(path.join(root, "out/README-execution.md"), note);
  const dir = path.resolve("generated-artifacts", j.parent); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const archive = path.join(dir, `${j.parent}-raw-out.tar.gz`);
  const r = await io.command("tar", ["-czf", archive, "-C", root, "out"], root, base, path.join(root, `archive-${Date.now()}.log`));
  checked(r, "Archive"); j.archives = [];
  if ((await fs.stat(archive)).size > 25_000_000) {
    checked(await io.command("split", ["-b", "24000000", "-d", "-a", "3", archive, `${archive}.part-`],
      root, base, path.join(root, `archive-split-${Date.now()}.log`)), "Split");
    j.archives = (await fs.readdir(dir)).filter(n => n.startsWith(path.basename(archive) + ".part-"))
      .sort().map(n => path.relative(process.cwd(), path.join(dir, n)));
  } else j.archives = [path.relative(process.cwd(), archive)];
  await event(`ARCHIVE_SAVED ${JSON.stringify(j.archives)}`);
}
async function dryRun() {
  const trace: string[] = [];
  for (const [rep, counts] of P95.order.entries()) for (const n of counts) {
    trace.push(`apply:${n}:r${rep + 1}`);
    await reverseLadder({ before: async () => {}, run: async rate => { trace.push(`run:${n}:${rate}`); },
      collect: async () => ({ retry: false }), preserve: async rate => { trace.push(`download:${n}:${rate}`); },
      gate: async () => {} });
    trace.push("destroy", "cleanup:both-regions", "wait:15-minutes", "cleanup:both-regions");
  }
  const sources = await controllerSources();
  console.log(JSON.stringify({ noAwsOrDatabaseCalls: true, measurementSha: P95.revision,
    controllerVersion: P95.controllerVersion, controllerHash: sources.sha256, trace,
    sourceManifest: sources.files.map(f => ({ path: f.file, sha256: hash(f.bytes) })),
    policy: P95, liveLadderDriverExercised: true }, null, 2));
}
async function main() {
  process.umask(0o077);
  if (process.argv[2] === "--dry-run") { await dryRun(); return; }
  if (process.argv[2] === "--watch") {
    const parent = process.argv[3];
    if (!/^typical-p95-v1-\d{8}$/.test(parent ?? "") || process.argv.length !== 4)
      throw new Error("Use --watch typical-p95-v1-YYYYMMDD");
    const journal = await read(path.join(ROOT, parent, "runner-state.json"));
    if (journal.paused || journal.slots.some((s: Slot) => s.applyAttempted && !s.delayed) ||
      !journal.nextSessionAt || !journal.nextSession) throw new Error("Read-only timer requires a clean, due session");
    console.log(`SESSION_WAIT next=${journal.nextSession} due=${journal.nextSessionAt} no-AWS-or-database-calls=true`);
    await io.wait(Math.max(0, Date.parse(journal.nextSessionAt) - Date.now()));
    console.log(`NEXT_SESSION_DUE ${parent} session=${journal.nextSession}`); return;
  }
  const parent = process.argv[3], rep = Number(process.argv[5]);
  if (process.argv[2] !== "--campaign" || !/^typical-p95-v1-\d{8}$/.test(parent ?? "") ||
    process.argv[4] !== "--session" || ![1, 2, 3].includes(rep) || process.argv.length !== 6)
    throw new Error("Use --dry-run or --campaign typical-p95-v1-YYYYMMDD --session 1|2|3");
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await withProcessLock(path.join(ROOT, ".execution.flock"), async () => {
    root = path.join(ROOT, parent); await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const sources = await controllerSources();
    j = await exists(path.join(root, "runner-state.json")) ? await read(path.join(root, "runner-state.json")) :
      { parent, revision: P95.revision, controllerHash: sources.sha256, slots: [], days: {}, missingRawApplies: [] };
    if (j.revision !== P95.revision || j.controllerHash !== sources.sha256)
      throw new PauseRequired("Frozen measurement/controller hash changed; ask Kevin before a fix");
    if (j.paused) throw new PauseRequired("Campaign paused for Kevin; no automatic restart");
    if (j.finishedAt && j.archives) return;
    if (!await exists(path.join(root, "out/verification/controller-manifest.json"))) {
      for (const f of sources.files) await io.text(path.join(root, "out/verification/controller-source", f.file), f.bytes.toString());
      await io.json(path.join(root, "out/verification/controller-manifest.json"), {
        version: P95.controllerVersion, sha256: sources.sha256,
        files: sources.files.map(f => ({ path: f.file, sha256: hash(f.bytes) })), outsideBenchmarkRepo: true });
      await io.json(path.join(root, "out/verification/creator-controller-approval.json"), {
        at: new Date().toISOString(), approval: "Approved. Keep it outside the cwm-bench repo and record its version or hash in the evidence.",
        required: ["300→200→100", "no rung retries", "whole applies only", "up to 6 replacements",
          "$40 cap; pause and ask, do not stop", "section 12 session order", "download every gzip", "no-AWS dry run first"],
        frozenMeasurementSha: P95.revision });
      await io.json(path.join(root, "out/verification/spend-guard-basis.json"), {
        hourlyConservativeCeilingUsd: P95.hourlyCeilingUsd, fixedOverheadReserveUsd: P95.overheadReserveUsd,
        cleanupReserveUsd: P95.cleanupReserveUsd, applyReserveHours: P95.nextApplyReserveHours,
        exportEgressReserveUsdPerGiB: P95.transferUsdPerGiB, actualBillingClaim: false,
        includesExtendedSupport: true, knownEc2HourlyUsd: { "m5.large": 0.096, "c6i.xlarge": 0.17 },
        pricingSource: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-2/index.json",
        excessAction: "destroy, pause, ask Kevin; never label partial without his stop decision" });
    }
    await persist(); io.installSignals();
    base = await scaleCredentials(io, TF); cloud = new P95Cloud(io, root, base);
    let watch: ReturnType<typeof setInterval> | undefined;
    try {
      const version = await io.command(TF, ["version", "-json"], root, base, path.join(root, `terraform-version-${Date.now()}.json`));
      if (version.value?.terraform_version !== "1.9.8") throw new PauseRequired("Terraform 1.9.8 required");
      const identity = await cloud.aws(P95.region, ["sts", "get-caller-identity"],
        path.join(root, `out/aws-identity-${Date.now()}.json`));
      if (!/^\d{12}$/.test(identity.Account) || (j.account && j.account !== identity.Account))
        throw new PauseRequired("AWS account identity mismatch");
      j.account = identity.Account;
      if (!j.ami) {
        const ami = await cloud.aws(P95.region, ["ssm", "get-parameter", "--name",
          "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"],
          path.join(root, `out/pinned-ami-resolution-${Date.now()}.json`));
        if (!/^ami-[a-f0-9]+$/.test(ami.Parameter?.Value)) throw new PauseRequired("AL2023 AMI resolution failed");
        j.ami = ami.Parameter.Value; await persist();
      }
      watch = setInterval(() => {
        if (!io.cleaning && !io.interrupted && spendUpperBound(j.slots) + P95.cleanupReserveUsd >= P95.budgetUsd) {
          j.paused = "Spend guard reached cleanup reserve; ask Kevin"; io.interrupted = true; io.active?.kill("SIGTERM");
        }
      }, 15_000);
      // Never rerun an interrupted rung/apply; clean up before a supervised replacement.
      for (const s of j.slots.filter(s => s.applyAttempted && !s.delayed)) {
        if (!s.destroyed) { s.valid = false; s.invalidReason = "interrupted-apply-or-ladder"; await persist(); await destroy(s); }
        await delayed(s);
      }
      await executeSession(rep);
    } catch (e) {
      j.paused = j.paused ?? io.redact(e instanceof Error ? e.message : "Execution failure; ask Kevin");
      await persist(); io.cleaning = true;
      for (const s of j.slots.filter(s => s.applyAttempted && !s.delayed)) {
        try { await destroy(s); await delayed(s); }
        catch { await io.json(path.join(s.out, `cleanup-unresolved-${Date.now()}.json`),
          { unresolved: true, urgentCreatorAttention: true, noManualDeletion: true }); }
      }
      await event(`CAMPAIGN_PAUSED ${j.paused}`); process.exitCode = 3;
    } finally { if (watch) clearInterval(watch); }
  });
}
main().catch(e => { console.error(io.redact(e instanceof Error ? e.message : "Controller failure")); process.exitCode = 3; });
