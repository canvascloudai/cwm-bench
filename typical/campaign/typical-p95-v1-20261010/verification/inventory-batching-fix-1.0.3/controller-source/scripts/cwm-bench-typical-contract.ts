export const TYPICAL_CAMPAIGN = {
  repository: "https://github.com/canvascloudai/cwm-bench.git",
  revision: "6aa574d7ff9d3080b88b221bcd59f7d218ae37f0",
  adapterVersion: "1.3.0",
  region: "us-east-2",
  profile: "typical",
  workers: 2,
  warmup: "5m",
  duration: "15m",
  steadyWindowMinutes: 15,
  requiredScenarios: [
    "typical-fit-20",
    "typical-fit-100",
    "typical-fit-200",
    "typical-holdout-300",
  ],
  optionalScenario: "typical-saturation-500",
} as const;
export const TYPICAL_TERRAFORM_VERSION = "1.9.8";

export const ACTIVE_CAMPAIGN_STATES = new Set([
  "queued",
  "waiting_for_later_day",
  "provisioning",
  "warming",
  "running",
  "collecting",
  "validating",
  "cleaning_up",
]);

export interface CampaignStatus {
  id: string;
  status: string;
  cleanupStatus: string;
}

export function findBlockingCampaigns(campaigns: readonly CampaignStatus[]): CampaignStatus[] {
  return campaigns.filter((campaign) =>
    ACTIVE_CAMPAIGN_STATES.has(campaign.status)
    || campaign.cleanupStatus !== "confirmed"
  );
}

export function isCampaignSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(value);
}

export function isDevelopmentCredentialName(value: string): boolean {
  return /\bdevelopment\b/i.test(value);
}

export function shouldRunOptionalScenario(
  requiredCollects: readonly boolean[],
  requiredCpuPeaksKnown: readonly boolean[] = [],
): boolean {
  return requiredCollects.length === TYPICAL_CAMPAIGN.requiredScenarios.length
    && requiredCollects.every(Boolean)
    && requiredCpuPeaksKnown.length === TYPICAL_CAMPAIGN.requiredScenarios.length
    && requiredCpuPeaksKnown.every(Boolean);
}

export function extractRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const runId = result.runId ?? result.run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export function adapterIdentityEnvironment(
  campaignId: string,
  runId: string,
  scenario: string,
): Record<string, string> {
  return {
    CWM_CAMPAIGN_ID: campaignId,
    CWM_RUN_ID: runId,
    CWM_SCENARIO: scenario,
  };
}

export function extractRunCompletedAt(value: unknown): Date | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stdout = (value as Record<string, unknown>).remoteStdout;
  if (typeof stdout !== "string") return null;
  const match = stdout.match(/(?:^|\n)completed_at=([^\s\r\n]+)/);
  if (!match?.[1]) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function adapterCollectEnvironment(
  campaignId: string,
  runId: string,
  scenario: string,
  runResult: unknown,
): Record<string, string> {
  const env = adapterIdentityEnvironment(campaignId, runId, scenario);
  const completedAt = extractRunCompletedAt(runResult);
  if (completedAt) {
    env.CWM_RUN_STARTED_AT = new Date(
      completedAt.getTime() - TYPICAL_CAMPAIGN.steadyWindowMinutes * 60 * 1000,
    ).toISOString();
    env.CWM_RUN_ENDED_AT = completedAt.toISOString();
  }
  return env;
}

export function adapterResultOk(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).ok === true,
  );
}

export function isCollectIncomplete(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const error = result.error;
  const code = typeof error === "string"
    ? error
    : error && typeof error === "object"
      ? (error as Record<string, unknown>).code
      : result.errorCode ?? result.code;
  return code === "COLLECT_INCOMPLETE";
}

export function findGeneratorCpuPeak(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cloudwatch = (value as Record<string, unknown>).cloudwatch;
  if (!cloudwatch || typeof cloudwatch !== "object" || Array.isArray(cloudwatch)) return null;
  const metrics = (cloudwatch as Record<string, unknown>).metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const generatorCpu = (metrics as Record<string, unknown>).generator_cpu;
  if (!generatorCpu || typeof generatorCpu !== "object" || Array.isArray(generatorCpu)) return null;
  const datapoints = (generatorCpu as Record<string, unknown>).datapoints;
  if (!Array.isArray(datapoints)) return null;
  const found = datapoints.flatMap((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) return [];
    const maximum = (point as Record<string, unknown>).maximum;
    return typeof maximum === "number" && Number.isFinite(maximum) ? [maximum] : [];
  });
  return found.length ? Math.max(...found) : null;
}

export function safeAttemptName(scenario: string, attempt: number): string {
  return attempt === 1 ? scenario : `${scenario}-attempt${attempt}`;
}

export function isRetryableSsmTransportFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  const details = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const code = typeof details.code === "string" ? details.code : "";
  const stdout = typeof (value as Record<string, unknown>).remoteStdout === "string"
    ? (value as Record<string, unknown>).remoteStdout as string
    : "";
  if (code === "SSM_EXECUTION_FAILED" && /ADAPTER_K6_COMPLETE\b/.test(stdout)) return false;
  if ([
    "SSM_SEND_FAILED",
    "SSM_EXECUTION_FAILED",
    "K6_WAIT_SSM_FAILED",
    "K6_STATUS_TIMEOUT",
    "K6_STATUS_UNKNOWN",
  ].includes(code)) return true;
  return code === "AWS_CLI_FAILED"
    && typeof details.message === "string"
    && /throttl|timeout|timed out|temporar|connect|connection|service unavailable|internal error|network/i
      .test(details.message);
}

export function shouldRetryRunFailure(
  value: unknown,
  attempt: number,
  teardownSucceeded: boolean,
): boolean {
  return attempt === 1
    && !adapterResultOk(value)
    && isRetryableSsmTransportFailure(value)
    && teardownSucceeded;
}

export function shouldRetryForGeneratorCpu(peak: number | null, attempt: number): boolean {
  return attempt === 1 && peak !== null && peak > 70;
}

export interface CleanupInventoryStatus {
  confirmed: boolean;
  resourceIds: string[];
}

export function inspectCleanupInventory(
  tagged: unknown,
  rds: unknown,
  ec2: unknown,
): CleanupInventoryStatus {
  const ids: string[] = [];
  let valid = true;
  const tagMappings = tagged && typeof tagged === "object" && !Array.isArray(tagged)
    ? (tagged as Record<string, unknown>).ResourceTagMappingList
    : null;
  if (!Array.isArray(tagMappings)) valid = false;
  else {
    for (const entry of tagMappings) {
      const arn = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).ResourceARN
        : null;
      if (typeof arn === "string") ids.push(arn);
      else valid = false;
    }
  }

  if (Array.isArray(rds)) {
    for (const row of rds) {
      if (Array.isArray(row) && typeof row[0] === "string") ids.push(`rds:${row[0]}`);
      else valid = false;
    }
  } else valid = false;

  const reservations = ec2 && typeof ec2 === "object" && !Array.isArray(ec2)
    ? (ec2 as Record<string, unknown>).Reservations
    : null;
  if (!Array.isArray(reservations)) valid = false;
  else {
    for (const reservation of reservations) {
      const instances = reservation && typeof reservation === "object" && !Array.isArray(reservation)
        ? (reservation as Record<string, unknown>).Instances
        : null;
      if (!Array.isArray(instances)) {
        valid = false;
        continue;
      }
      for (const instance of instances) {
        const id = instance && typeof instance === "object" && !Array.isArray(instance)
          ? (instance as Record<string, unknown>).InstanceId
          : null;
        if (typeof id === "string") ids.push(`ec2:${id}`);
        else valid = false;
      }
    }
  }
  return { confirmed: valid && ids.length === 0, resourceIds: [...new Set(ids)] };
}

export function isTerraform198(output: string): boolean {
  return /^Terraform v1\.9\.8(?:\s|$)/m.test(output);
}

export function mayReleaseRunnerLock(
  cleanupConfirmed: boolean,
  cleanupErrors: readonly unknown[],
): boolean {
  return cleanupConfirmed && cleanupErrors.length === 0;
}