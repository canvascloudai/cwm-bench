import { extractRunCompletedAt } from "./cwm-bench-typical-contract";

export const HOLDOUT = {
  repository: "https://github.com/canvascloudai/cwm-bench.git",
  revision: "64c6e89d74e25c549e7dad740471443621da5aac",
  adapterVersion: "1.4.0",
  fitDate: "2026-09-27",
  regions: ["us-east-2", "us-west-2"],
  scenarios: [
    ["typical-later-day", "typical-later-day-300"],
    ["typical-second-region", "typical-second-region-300"],
  ],
} as const;

export function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function childId(region: string, date: Date): string {
  if (!HOLDOUT.regions.includes(region as typeof HOLDOUT.regions[number])) throw new Error("Unsupported region");
  return `typical-${region === "us-east-2" ? "later-day" : "second-region"}-${utcStamp(date)}`;
}

export function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(CWM_|AWS_|TF_VAR_|TF_CLI_ARGS|PG_CONN_STR$|PG_SCHEMA_NAME$)/.test(key)) delete env[key];
  }
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_PAGER = "";
  env.TF_IN_AUTOMATION = "true";
  return env;
}

export function regionEnvironment(base: NodeJS.ProcessEnv, region: string, campaign: string): NodeJS.ProcessEnv {
  const env = { ...base, AWS_REGION: region, AWS_DEFAULT_REGION: region, CWM_CAMPAIGN_ID: campaign };
  delete env.CWM_RUN_ID;
  delete env.CWM_WARMUP;
  delete env.CWM_DURATION;
  delete env.CWM_FIT_CAMPAIGN_DATE;
  if (region === "us-east-2") env.CWM_FIT_CAMPAIGN_DATE = HOLDOUT.fitDate;
  return env;
}

export function validReadiness(value: any, region: string): boolean {
  return value?.ok === true && value?.provisioned === true
    && value.adapterVersion === HOLDOUT.adapterVersion && value.terraform?.region === region
    && value.ready?.appHealth === true && value.ready?.generatorSsm === true
    && Array.isArray(value.appNodes) && value.appNodes.length === 2
    && value.appNodes.every((node: any) =>
      node.profile === "typical" && node.workers === 2 && node.gitSha === HOLDOUT.revision);
}

export function capabilityValid(value: any): boolean {
  return value?.ok === true && value.adapterVersion === HOLDOUT.adapterVersion
    && HOLDOUT.scenarios.flat().every(key => value.supportedScenarios?.includes(key));
}

export function terraformVariables(region: string, campaign: string): string[] {
  return [
    `-var=region=${region}`, `-var=test_id=${campaign}`,
    "-var=app_profile=typical", "-var=app_workers=2",
    `-var=app_source_git_ref=${HOLDOUT.revision}`,
  ];
}

export function pgConnection(connection: string): string {
  const url = new URL(connection);
  if (url.hostname.endsWith(".neon.tech") && !url.searchParams.get("options")?.includes("endpoint=")) {
    const endpoint = url.hostname.split(".")[0].replace(/-pooler$/, "");
    url.searchParams.set("options", [url.searchParams.get("options"), `endpoint=${endpoint}`].filter(Boolean).join(" "));
  }
  return url.toString();
}

export function emptyInitialState(code: number, stdout: string, stderr: string): boolean {
  const diagnostic = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  return !stdout.trim() && (code === 0 || (code === 1 && /^No state file was found!/m.test(diagnostic)));
}

export function collectEnvironment(base: NodeJS.ProcessEnv, scenario: string, run: any): NodeJS.ProcessEnv {
  if (!run?.runId || run.campaignId !== base.CWM_CAMPAIGN_ID || run.scenario !== scenario) {
    throw new Error("Run identity unavailable or mismatched; refusing to collect");
  }
  // The load command has no run-ID override. Collect requires the ID returned by
  // that command; bind it only to this child invocation, never to the run env.
  const completedAt = extractRunCompletedAt(run);
  return { ...base, CWM_RUN_ID: run.runId, CWM_SCENARIO: scenario,
    ...(completedAt ? {
      CWM_RUN_STARTED_AT: new Date(completedAt.getTime() - 15 * 60_000).toISOString(),
      CWM_RUN_ENDED_AT: completedAt.toISOString(),
    } : {}),
  };
}
