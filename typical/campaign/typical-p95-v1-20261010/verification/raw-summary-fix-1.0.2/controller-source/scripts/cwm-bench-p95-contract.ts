import { cleanEnvironment, utcStamp } from "./cwm-bench-holdout-contract";
import { assertTopology, assertCollectWindow } from "./cwm-bench-scale-contract";

export const P95 = {
  controllerVersion: "1.0.2",
  repository: "https://github.com/canvascloudai/cwm-bench.git",
  revision: "0815668ced5c219313b02efba0279ef2ae55fa0c",
  version: "1.6.1", region: "us-east-2",
  order: [[1, 2, 3], [2, 3, 1], [3, 1, 2]],
  rates: [300, 200, 100], replacements: 6, budgetUsd: 40,
  // Conservative spend guard, NOT a claim about actual AWS billing.
  hourlyCeilingUsd: 2, overheadReserveUsd: 2, cleanupReserveUsd: 2,
  nextApplyReserveHours: 2, transferUsdPerGiB: 0.12,
} as const;

export class PauseRequired extends Error {}
export class InvalidApply extends Error {}
export function p95Id(n: number, rep: number, date: Date, suffix = ""): string {
  if (![1, 2, 3].includes(n) || ![1, 2, 3].includes(rep) || !/^[a-f]?$/.test(suffix))
    throw new Error("Invalid P95 apply identity");
  return `typical-p95-${n}x-r${rep}${suffix}-${utcStamp(date)}`;
}
export function p95Variables(n: number, campaign: string, ami: string): string[] {
  if (!/^ami-[a-f0-9]+$/.test(ami)) throw new Error("Invalid pinned AMI");
  return [`-var=region=${P95.region}`, `-var=test_id=${campaign}`, `-var=app_count=${n}`,
    `-var=ami_id=${ami}`, `-var=app_source_git_ref=${P95.revision}`,
    "-var=app_profile=typical", "-var=app_workers=2"];
}
export function p95Environment(base: NodeJS.ProcessEnv, campaign: string, schema: string, tfdir: string) {
  const env = cleanEnvironment(base);
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "PG_CONN_STR"])
    if (base[k]) env[k] = base[k];
  return { ...env, AWS_REGION: P95.region, AWS_DEFAULT_REGION: P95.region,
    CWM_CAMPAIGN_ID: campaign, CWM_MEASUREMENT_SHA: P95.revision,
    CWM_TERRAFORM_DIR: tfdir, PG_SCHEMA_NAME: schema };
}
export function p95Capability(v: any): boolean {
  return v?.ok === true && v.adapterVersion === P95.version &&
    [1, 2, 3].every(n => P95.rates.every(r => v.supportedScenarios?.includes(`typical-p95-${n}x-${r}`)));
}
export function p95Ready(v: any, n: number): void {
  if (!p95Capability(v) || !v.provisioned || v.terraform?.region !== P95.region ||
    !v.ready?.appHealth || !v.ready?.generatorSsm || v.appNodes?.length !== n ||
    !v.appNodes.every((a: any) => a.profile === "typical" && a.workers === 2 && a.gitSha === P95.revision))
    throw new InvalidApply("Readiness identity mismatch");
}
export function p95Topology(v: any, n: number, ami: string): void {
  try { assertTopology(v, n, ami); } catch { throw new InvalidApply("Topology/AMI mismatch"); }
  const t = v.topology_declaration.value;
  if (t.db_instance_class !== "db.r5.large" || t.generator_instance_type !== "c6i.xlarge" ||
    t.db_engine !== "mysql" || t.db_multi_az !== false || t.alb !== "application")
    throw new InvalidApply("Frozen database/generator/ALB topology mismatch");
}
export function p95RunIdentity(v: any, campaign: string, scenario: string, runId: string, pos: number): void {
  if (v?.ok !== true || v.adapterVersion !== P95.version || v.campaignId !== campaign ||
    v.scenario !== scenario || v.runId !== runId || JSON.stringify(v.ladder) !== JSON.stringify(P95.rates) ||
    v.rung_pos !== pos || JSON.stringify(v.ladder_history) !== JSON.stringify(P95.rates.slice(0, pos)))
    throw new InvalidApply("Failed run, identity mismatch, or incomplete reverse ladder");
}
export type Bounds = { start: string; end: string; complete: boolean };
export function cloudwatchGaps(c: any, b: Bounds): string[] {
  const reasons: string[] = [];
  if (c?.cloudwatch?.window?.source !== "persisted-run") reasons.push("window");
  const start = Date.parse(b.start) + 300_000, end = start + 900_000;
  const metrics = c?.cloudwatch?.metrics ?? {};
  const labels = new Set(["generator_cpu", "rds_cpu", "rds_connections", "alb_target_response_time"]);
  for (const k of Object.keys(metrics)) if (k.startsWith("app_cpu_")) labels.add(k);
  for (const k of labels) {
    const stamps = new Set((metrics[k]?.datapoints ?? []).map((d: any) => Date.parse(d.timestamp))
      .filter((t: number) => t >= start && t < end));
    if (15 - stamps.size > 2) reasons.push(k);
  }
  return reasons;
}
export function needsRecollect(c: any, b: Bounds, attempt: number): boolean {
  if (attempt >= 3) return false;
  return !c?.artifacts?.k6?.present || c?.latency?.p95Ms == null || cloudwatchGaps(c, b).length > 0 ||
    (attempt === 1 && c?.artifacts?.requestLevelRaw?.present !== true);
}
export function p95CollectGate(c: any, b: Bounds, n: number, ami: string,
  campaign: string, scenario: string, runId: string, pos: number): void {
  if (c?.adapterVersion !== P95.version || c.campaignId !== campaign || c.scenario !== scenario ||
    c.runId !== runId || c.invented !== false || c.artifacts?.identityMatches !== true ||
    (c.identityMatches !== undefined && c.identityMatches !== true) ||
    JSON.stringify(c.ladder) !== JSON.stringify(P95.rates) || c.rung_pos !== pos ||
    JSON.stringify(c.ladder_history) !== JSON.stringify(P95.rates.slice(0, pos)))
    throw new InvalidApply("Collect identity/ladder mismatch");
  const t = c.terraformOutputs;
  p95Topology({ topology_declaration: { value: t?.topology_declaration },
    app_instance_ids: { value: t?.app_instance_ids }, resolved_ami_id: { value: c.resolvedAmis?.amiId },
    ami_source: { value: c.resolvedAmis?.source } }, n, ami);
  // Require provenance in the unmodified 1.6.1 collector response, not an enriched copy.
  if (c.measurementSha !== P95.revision)
    throw new InvalidApply("Collect SHA mismatch");
  if (c.cloudwatch?.window?.source === "persisted-run") {
    try { assertCollectWindow(c, b); } catch { throw new InvalidApply("Collect bounds mismatch"); }
  }
  if (!c.artifacts?.k6?.present || c.latency?.p95Ms == null) throw new InvalidApply("Missing k6 summary");
  if (c.latency?.untaggedAggregate !== true) throw new PauseRequired("Latency definition violation; ask Kevin before any fix");
  if (c.ok !== true && c.error?.code !== "COLLECT_INCOMPLETE") throw new InvalidApply("Collect error");
}
export function generatorGate(c: any, b: Bounds, rate: number): { valid: boolean; reason: string | null } {
  const start = Date.parse(b.start) + 300_000, end = start + 900_000;
  const values = (c?.cloudwatch?.metrics?.generator_cpu?.datapoints ?? [])
    .filter((d: any) => Date.parse(d.timestamp) >= start && Date.parse(d.timestamp) < end &&
      typeof d.average === "number" && Number.isFinite(d.average)).map((d: any) => d.average);
  const mean = values.length ? values.reduce((a: number, v: number) => a + v, 0) / values.length : null;
  const k6 = c.artifacts?.k6 ?? {}, dropped = k6.droppedIterations ?? 0;
  if (typeof dropped !== "number" || !Number.isFinite(dropped) || dropped < 0)
    return { valid: false, reason: "generator-dropped-iterations-unavailable" };
  if (dropped > rate * 1050 * 0.005) return { valid: false, reason: "generator-dropped-iterations-above-limit" };
  if (mean !== null && mean > 70) return { valid: false, reason: "generator-steady-mean-cpu-above-limit" };
  if (mean === null && !(typeof k6.peakVus === "number" && k6.peakVus < (rate <= 100 ? 80 : 400)))
    return { valid: false, reason: "generator-missing-cpu-fallback-failed" };
  return { valid: true, reason: null };
}
export function summaryGate(summary: any, c: any): void {
  const metrics = summary?.metrics;
  if (!metrics?.http_req_duration) throw new InvalidApply("Downloaded k6 summary missing aggregate");
  if (Object.keys(metrics).some(k => /^http_req_duration\{.*phase:steady/.test(k)))
    throw new PauseRequired("Steady latency submetric appeared; definition violation; ask Kevin");
  const m = metrics.http_req_duration.values ?? metrics.http_req_duration;
  if (m["p(95)"] !== c.latency?.p95Ms) throw new PauseRequired("Summary/collect aggregate definition mismatch; ask Kevin");
}
export type SpendSlot = { applyStartedAt?: string; destroyedAt?: string; exportedBytes?: number };
export type ReplacementReservation = { n: number; rep: number; suffix: string };
export function replacementUsage(slots: { n: number; rep: number; suffix: string; applyAttempted: boolean }[],
  reservation?: ReplacementReservation): number {
  const attempted = slots.filter(s => s.applyAttempted && s.suffix);
  const reserved = reservation && !attempted.some(s =>
    s.n === reservation.n && s.rep === reservation.rep && s.suffix === reservation.suffix);
  return attempted.length + (reserved ? 1 : 0);
}
export function spendUpperBound(slots: SpendSlot[], now = Date.now()): number {
  return P95.overheadReserveUsd + slots.reduce((sum, s) => {
    const hours = s.applyStartedAt ? Math.max(0, ((s.destroyedAt ? Date.parse(s.destroyedAt) : now) -
      Date.parse(s.applyStartedAt)) / 3600_000) : 0;
    return sum + hours * P95.hourlyCeilingUsd + (s.exportedBytes ?? 0) / 2 ** 30 * P95.transferUsdPerGiB;
  }, 0);
}
export function budgetGate(slots: SpendSlot[], replacementsUsed: number, replacement: boolean, now = Date.now()): void {
  if (replacement && replacementsUsed >= P95.replacements)
    throw new PauseRequired("Six replacements used; ask Kevin to raise the budget or stop");
  if (spendUpperBound(slots, now) + P95.nextApplyReserveHours * P95.hourlyCeilingUsd +
    P95.cleanupReserveUsd > P95.budgetUsd)
    throw new PauseRequired("Next apply exceeds conservative $40 spend guard; ask Kevin to raise budget or stop");
}

export interface LadderPort {
  before(rate: number, pos: number): Promise<void>;
  run(rate: number, pos: number): Promise<void>;
  collect(rate: number, pos: number, attempt: number): Promise<{ retry: boolean }>;
  preserve(rate: number, pos: number): Promise<void>;
  gate(rate: number, pos: number): Promise<void>;
}
// This function is shared by live execution and the no-AWS injected-port dry run.
export async function reverseLadder(port: LadderPort): Promise<void> {
  for (const [i, rate] of P95.rates.entries()) {
    await port.before(rate, i + 1);
    await port.run(rate, i + 1); // Exactly one run invocation. No rung retry path.
    await port.preserve(rate, i + 1); // Gzip verification precedes summary interpretation/collect.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!(await port.collect(rate, i + 1, attempt)).retry) break;
    }
    await port.gate(rate, i + 1);
  }
}
