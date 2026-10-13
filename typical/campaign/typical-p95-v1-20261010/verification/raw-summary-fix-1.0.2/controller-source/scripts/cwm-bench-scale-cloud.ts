import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HoldoutIO } from "./cwm-bench-holdout-io";
import { cleanEnvironment, pgConnection } from "./cwm-bench-holdout-contract";
import { isDevelopmentCredentialName, findBlockingCampaigns } from "./cwm-bench-typical-contract";
import { reconcileCleanup, retainedInventoryArns, validateInventory, type Inventory } from "./cwm-bench-holdout-cleanup";
import { retryTimedOutCleanupReads } from "./cwm-bench-scale-cleanup";

export async function scaleCredentials(io: HoldoutIO, terraform: string): Promise<NodeJS.ProcessEnv> {
  const [{ db }, { users, cloudCredentials, benchmarkCampaigns }, { encryptionService }, { and, eq }] = await Promise.all([
    import("@db"), import("@db/schema"), import("../server/services/encryption"), import("drizzle-orm"),
  ]);
  const [owner] = await db.select({ username: users.username }).from(users).where(eq(users.id, 1));
  if (owner?.username !== "mathsociety") throw new Error("Unexpected benchmark owner");
  const rows = (await db.select().from(cloudCredentials).where(and(eq(cloudCredentials.userId, 1),
    eq(cloudCredentials.provider, "aws"), eq(cloudCredentials.isActive, true))))
    .filter(r => isDevelopmentCredentialName(r.name));
  if (rows.length !== 1) throw new Error("Expected one active Development AWS connection");
  const campaigns = await db.select({ id: benchmarkCampaigns.id, status: benchmarkCampaigns.status,
    cleanupStatus: benchmarkCampaigns.cleanupStatus }).from(benchmarkCampaigns);
  if (findBlockingCampaigns(campaigns).length) throw new Error("Active database campaign blocks provisioning");
  let raw: string;
  try { raw = encryptionService.decrypt(rows[0].credentials, "1"); }
  catch { raw = encryptionService.decrypt(rows[0].credentials); }
  const c = JSON.parse(raw);
  const access = c.accessKeyId ?? c.access_key_id ?? c.aws_access_key_id;
  const secret = c.secretAccessKey ?? c.secret_access_key ?? c.aws_secret_access_key;
  const token = c.sessionToken ?? c.session_token;
  if (!access || !secret || !process.env.DATABASE_URL) throw new Error("Runtime credentials/backend unavailable");
  const connection = pgConnection(process.env.DATABASE_URL);
  io.secrets.push(access, secret, connection, decodeURIComponent(new URL(connection).password));
  if (token) io.secrets.push(token);
  return { ...cleanEnvironment(process.env), AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret,
    ...(token ? { AWS_SESSION_TOKEN: token } : {}), PG_CONN_STR: connection,
    PATH: `${path.dirname(terraform)}${path.delimiter}${process.env.PATH}` };
}

export class ScaleCloud {
  constructor(readonly io: HoldoutIO, readonly root: string, readonly env: NodeJS.ProcessEnv) {}
  async query(region: string, args: string[], file: string) {
    const r = await this.io.command("aws", [...args, "--region", region, "--output", "json"], this.root, this.env, file, 120_000);
    return { ...r, stderr: await fs.readFile(`${file}.stderr.txt`, "utf8") };
  }
  async aws(region: string, args: string[], file: string): Promise<any> {
    const r = await this.query(region, args, file);
    if (r.code !== 0 || r.value === null) throw new Error(`AWS query failed: ${path.basename(file)}`);
    return r.value;
  }
  async inventory(region: string, campaigns: string[], out: string): Promise<Inventory> {
    const a = (args: string[], name: string) => this.aws(region, args, path.join(out, region, name));
    const tags = await a(["resourcegroupstaggingapi", "get-resources", "--tag-filters", `Key=TestId,Values=${campaigns.join(",")}`], "tagged.json");
    const ec2 = await a(["ec2", "describe-instances", "--filters", `Name=tag:TestId,Values=${campaigns.join(",")}`,
      "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped"], "ec2.json");
    const volumes = await a(["ec2", "describe-volumes", "--filters", `Name=tag:TestId,Values=${campaigns.join(",")}`], "volumes.json");
    const rules = await a(["ec2", "describe-security-group-rules", "--filters", `Name=tag:TestId,Values=${campaigns.join(",")}`], "security-group-rules.json");
    const rds = await a(["rds", "describe-db-instances"], "rds.json");
    const result = { region, checkedAt: new Date().toISOString(), campaigns,
      taggedArns: tags.ResourceTagMappingList.map((r: any) => r.ResourceARN),
      liveInstanceIds: ec2.Reservations.flatMap((r: any) => r.Instances.map((i: any) => i.InstanceId)),
      volumeIds: volumes.Volumes.map((v: any) => v.VolumeId),
      ruleIds: rules.SecurityGroupRules.map((r: any) => r.SecurityGroupRuleId),
      rdsIds: rds.DBInstances.filter((r: any) => r.DBInstanceIdentifier.startsWith("cwm-bench")).map((r: any) => r.DBInstanceIdentifier) };
    validateInventory(result); await this.io.json(path.join(out, region, "summary.json"), result); return result;
  }
  async verifyCleanup(campaigns: string[], retainedRoots: string[], out: string, account: string) {
    const regions = ["us-east-2", "us-west-2"];
    const retained: Record<string, Set<string>> = Object.fromEntries(regions.map(r => [r, new Set<string>()]));
    for (const root of retainedRoots) {
      const previous = await retainedInventoryArns(root, campaigns, regions);
      for (const r of regions) for (const arn of previous[r]) retained[r].add(arn);
    }
    const inventories = [];
    for (const r of regions) inventories.push(await this.inventory(r, campaigns, out));
    const initial = await reconcileCleanup(inventories, regions, retained, account,
      (region, args, file) => this.query(region, args, file), path.join(out, "direct"));
    const result = await retryTimedOutCleanupReads(initial,
      (region, args, file) => this.query(region, args, file),
      proof => this.io.json(path.join(out, "cleanup-verification-attempt1.json"), proof));
    await this.io.json(path.join(out, "cleanup-verification.json"), result);
    if (!result.liveCleanupConfirmed) throw new Error("Live/unknown resources block the next apply");
    return result;
  }
  async remote(repo: string, env: NodeJS.ProcessEnv, instance: string, commands: string[], out: string) {
    const { runRemoteShell } = await import(pathToFileURL(path.join(repo, "scripts/lib/adapter/aws.mjs")).href);
    let index = 0;
    const runAws = async (args: string[]) => {
      const r = await this.io.command("aws", args, repo, env, path.join(out, `aws-${++index}.json`), 120_000);
      return { code: r.code, stdout: r.stdout, stderr: await fs.readFile(path.join(out, `aws-${index}.json.stderr.txt`), "utf8") };
    };
    const result = await runRemoteShell(runAws, { instanceId: instance, region: "us-east-2", commands,
      timeoutSeconds: 60, waitTimeoutMs: 120_000, pollMs: 2000, throwOnFailure: true, wait: (ms: number) => this.io.wait(ms) });
    await this.io.json(path.join(out, "remote.json"), result);
    return result;
  }
}
