import { cleanEnvironment, utcStamp } from "./cwm-bench-holdout-contract";

export const SCALE = {
  repository: "https://github.com/canvascloudai/cwm-bench.git",
  revision: "06e4048d9c6db5494dbb85da2911de4943a70383",
  version: "1.5.0",
  region: "us-east-2",
  order: [[2, 1, 3], [1, 3, 2], [3, 2, 1]],
  rates: [100, 200, 300],
} as const;

export function scaleKeys(): string[] {
  return [1, 2, 3].flatMap(n => SCALE.rates.map(r => `typical-scale-${n}x-${r}`));
}
export function applyId(n: number, rep: number, date: Date, repeat = false): string {
  if (![1, 2, 3].includes(n) || ![1, 2, 3].includes(rep)) throw new Error("Invalid scale cell");
  return `typical-scale-${n}x-r${rep}${repeat ? "a" : ""}-${utcStamp(date)}`;
}
export function scaleEnvironment(base: NodeJS.ProcessEnv, campaign: string, schema: string): NodeJS.ProcessEnv {
  const env = cleanEnvironment(base);
  // Reintroduce only the runtime credentials/backend provided by the controller.
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "PG_CONN_STR"])
    if (base[key]) env[key] = base[key];
  return { ...env, AWS_REGION: SCALE.region, AWS_DEFAULT_REGION: SCALE.region,
    CWM_CAMPAIGN_ID: campaign, PG_SCHEMA_NAME: schema };
}
export function scaleVariables(n: number, campaign: string, ami: string): string[] {
  if (!/^ami-[a-f0-9]+$/.test(ami)) throw new Error("Invalid pinned AMI");
  return [`-var=region=${SCALE.region}`, `-var=test_id=${campaign}`, `-var=app_count=${n}`,
    `-var=ami_id=${ami}`, `-var=app_source_git_ref=${SCALE.revision}`,
    "-var=app_profile=typical", "-var=app_workers=2"];
}
export function capabilityValid(v: any): boolean {
  return v?.ok === true && v.adapterVersion === SCALE.version && scaleKeys().every(k => v.supportedScenarios?.includes(k));
}
export function assertTopology(v: any, n: number, ami: string): void {
  const t = v?.topology_declaration?.value;
  if (t?.region !== SCALE.region || t.app_count !== n || t.app_pool_size !== 250 ||
    t.mysql_max_connections !== 500 || t.app_instance_type !== "m5.large" ||
    !Array.isArray(v.app_instance_ids?.value) || v.app_instance_ids.value.length !== n ||
    v.resolved_ami_id?.value !== ami || v.ami_source?.value !== "variable")
    throw new Error("Applied topology/AMI mismatch; no load authorized");
}
export function assertReady(v: any, n: number): void {
  if (!capabilityValid(v) || !v.provisioned || v.terraform?.region !== SCALE.region ||
    v.ready?.appHealth !== true || v.ready?.generatorSsm !== true ||
    !Array.isArray(v.appNodes) || v.appNodes.length !== n ||
    !v.appNodes.every((a: any) => a.profile === "typical" && a.workers === 2 && a.gitSha === SCALE.revision))
    throw new Error("Readiness identity/app-count mismatch; no load authorized");
}
export function parseRunBounds(stdout: string): { start: string; end: string; complete: boolean } {
  const get = (name: string) => [...stdout.matchAll(new RegExp(`^${name}=([^\\r\\n]+)`, "gm"))].at(-1)?.[1];
  const start = get("started_at"), end = get("completed_at");
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end))
    throw new Error("Generator run boundaries unavailable; refusing trailing-window collect");
  // A full-duration terminal run remains a result even if k6 exits nonzero.
  // Never reinterpret HTTP errors/saturation as permission for another load.
  const terminal = /^exit_code=\d+$/m.test(stdout);
  return { start, end, complete: /^exit_code=0$/m.test(stdout) ||
    (terminal && Date.parse(end) - Date.parse(start) >= 20 * 60_000) };
}
export function assertCollectWindow(v: any, bounds: { start: string; end: string }): void {
  const w = v?.cloudwatch?.window;
  if (w?.source !== "persisted-run" || Date.parse(w.actualStartTime) !== Date.parse(bounds.start) ||
    Date.parse(w.actualEndTime) !== Date.parse(bounds.end) ||
    Date.parse(w.startTime) < Date.parse(bounds.start) || Date.parse(w.endTime) > Date.parse(bounds.end))
    throw new Error("Collect window does not match this rung");
}
export function assertCollectIdentity(v: any, n: number, ami: string, campaign: string, scenario: string, runId: string): void {
  if (v?.adapterVersion !== SCALE.version || v.campaignId !== campaign || v.scenario !== scenario || v.runId !== runId)
    throw new Error("Collect identity mismatch");
  const t = v.terraformOutputs;
  if (t) assertTopology({
    topology_declaration: { value: t.topology_declaration },
    app_instance_ids: { value: t.app_instance_ids },
    resolved_ami_id: { value: v.resolvedAmis?.amiId }, ami_source: { value: v.resolvedAmis?.source },
  }, n, ami);
  if (v.ok && (!t || v.invented !== false || v.complete !== true || v.artifacts?.identityMatches !== true))
    throw new Error("Successful collect lacks complete, non-invented identity evidence");
}
export function steadyGeneratorPeak(v: any, bounds: { start: string; end: string }): number | null {
  const points = v?.cloudwatch?.metrics?.generator_cpu?.datapoints;
  if (!Array.isArray(points)) return null;
  const start = Date.parse(bounds.start) + 5 * 60_000, end = Date.parse(bounds.end);
  const values = points.filter((p: any) => {
    const t = Date.parse(p.timestamp ?? p.Timestamp);
    return t >= start && t + 60_000 <= end && Number.isFinite(p.maximum);
  }).map((p: any) => p.maximum);
  return values.length ? Math.max(...values) : null;
}
export function nextSessionAt(previous: string): number {
  if (!Number.isFinite(Date.parse(previous))) throw new Error("Invalid prior session timestamp");
  return Date.parse(previous) + 24 * 60 * 60_000;
}
