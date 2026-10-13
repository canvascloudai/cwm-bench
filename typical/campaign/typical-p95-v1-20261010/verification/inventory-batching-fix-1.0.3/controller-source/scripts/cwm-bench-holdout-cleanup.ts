import fs from "node:fs/promises";
import path from "node:path";
import type { HoldoutIO } from "./cwm-bench-holdout-io";

export type Inventory = {
  region: string; checkedAt: string; campaigns?: string[]; taggedArns: string[];
  liveInstanceIds: string[]; volumeIds: string[]; ruleIds: string[]; rdsIds: string[];
};
export type AwsQuery = (region: string, args: string[], file: string) =>
  Promise<{ code: number; value: any; stderr: string }>;
export type Classification = {
  region: string; arn: string; resourceId?: string; checkedAt: string; evidenceFile?: string;
  classification: "not-found" | "terminated" | "live" | "unresolved-unsupported-resource" |
    "unresolved-identity" | "unresolved-query";
};

const commands: Record<string, { prefix: string; operation: string; flag: string; list: string; id: string; absent: string }> = {
  instance: { prefix: "i", operation: "describe-instances", flag: "--instance-ids", list: "Reservations", id: "InstanceId", absent: "InvalidInstanceID.NotFound" },
  subnet: { prefix: "subnet", operation: "describe-subnets", flag: "--subnet-ids", list: "Subnets", id: "SubnetId", absent: "InvalidSubnetID.NotFound" },
  volume: { prefix: "vol", operation: "describe-volumes", flag: "--volume-ids", list: "Volumes", id: "VolumeId", absent: "InvalidVolume.NotFound" },
  "security-group-rule": { prefix: "sgr", operation: "describe-security-group-rules", flag: "--security-group-rule-ids", list: "SecurityGroupRules", id: "SecurityGroupRuleId", absent: "InvalidSecurityGroupRuleId.NotFound" },
  "security-group": { prefix: "sg", operation: "describe-security-groups", flag: "--group-ids", list: "SecurityGroups", id: "GroupId", absent: "InvalidGroup.NotFound" },
  vpc: { prefix: "vpc", operation: "describe-vpcs", flag: "--vpc-ids", list: "Vpcs", id: "VpcId", absent: "InvalidVpcID.NotFound" },
  "network-interface": { prefix: "eni", operation: "describe-network-interfaces", flag: "--network-interface-ids", list: "NetworkInterfaces", id: "NetworkInterfaceId", absent: "InvalidNetworkInterfaceID.NotFound" },
  "route-table": { prefix: "rtb", operation: "describe-route-tables", flag: "--route-table-ids", list: "RouteTables", id: "RouteTableId", absent: "InvalidRouteTableID.NotFound" },
  "internet-gateway": { prefix: "igw", operation: "describe-internet-gateways", flag: "--internet-gateway-ids", list: "InternetGateways", id: "InternetGatewayId", absent: "InvalidInternetGatewayID.NotFound" },
  "natgateway": { prefix: "nat", operation: "describe-nat-gateways", flag: "--nat-gateway-ids", list: "NatGateways", id: "NatGatewayId", absent: "InvalidNatGatewayID.NotFound" },
};

const rdsCommand = {
  operation: "describe-db-instances", flag: "--db-instance-identifier",
  list: "DBInstances", id: "DBInstanceIdentifier", absent: "DBInstanceNotFound",
};
const rdsLiveStates = new Set([
  "available", "backing-up", "configuring-enhanced-monitoring", "configuring-iam-database-auth",
  "configuring-log-exports", "converting-to-vpc", "creating", "delete-precheck", "deleting",
  "failed", "inaccessible-encryption-credentials", "inaccessible-encryption-credentials-recoverable",
  "incompatible-network", "incompatible-option-group", "incompatible-parameters", "incompatible-restore",
  "insufficient-capacity", "maintenance", "modifying", "moving-to-vpc", "rebooting", "renaming",
  "resetting-master-credentials", "restore-error", "starting", "stopped", "stopping",
  "storage-full", "storage-optimization", "upgrading",
]);
const natLiveStates = new Set(["pending", "failed", "available", "deleting"]);

export function validateInventory(value: any): asserts value is Inventory {
  if (!value || typeof value.region !== "string" || typeof value.checkedAt !== "string" ||
    !["taggedArns", "liveInstanceIds", "volumeIds", "ruleIds", "rdsIds"].every(key =>
      Array.isArray(value[key]) && value[key].every((id: unknown) => typeof id === "string" && id.length > 0))) {
    throw new Error("Malformed cleanup inventory");
  }
}

export function emptyLiveInventory(value: Inventory): boolean {
  validateInventory(value);
  return [value.liveInstanceIds, value.volumeIds, value.ruleIds, value.rdsIds].every(ids => ids.length === 0);
}

export async function classifyArn(region: string, arn: string, account: string,
  query: AwsQuery, evidenceFile: string): Promise<Classification> {
  const result: Classification = { region, arn, checkedAt: new Date().toISOString(), classification: "unresolved-identity" };
  const match = /^arn:aws:(ec2|rds):([^:]+):(\d{12}):(.+)$/.exec(arn);
  if (!match) return { ...result, classification: "unresolved-unsupported-resource" };
  const [, service = "", arnRegion = "", arnAccount = "", resource = ""] = match;
  const identity = (service === "ec2" ? /^([^/]+)\/([^/:]+)$/ : /^(db):([^/:]+)$/).exec(resource);
  if (!identity) return { ...result, classification: "unresolved-unsupported-resource" };
  const [, kind = "", id = ""] = identity;
  result.resourceId = id;
  if (arnRegion !== region || arnAccount !== account || !/^\d{12}$/.test(account)) return result;
  const ec2Command = service === "ec2" && Object.hasOwn(commands, kind) ? commands[kind] : undefined;
  const command = service === "rds" && kind === "db" ? rdsCommand : ec2Command;
  const validId = service === "rds" ?
    /^[a-z][a-z0-9-]{0,62}$/.test(id) && !id.endsWith("-") && !id.includes("--") :
    ec2Command && new RegExp(`^${ec2Command.prefix}-[a-f0-9]+$`).test(id);
  if (!command || !validId) {
    return { ...result, classification: "unresolved-unsupported-resource" };
  }
  result.evidenceFile = evidenceFile;
  try {
    const response = await query(region, [service, command.operation, command.flag, id], evidenceFile);
    if (!Number.isInteger(response.code) || typeof response.stderr !== "string" ||
      /COMMAND_TIMEOUT|OUTPUT_LIMIT_EXCEEDED/.test(response.stderr)) throw new Error("Incomplete query");
    // Accept only the specific service error from the exact-ID Describe call.
    // Timeouts/output truncation must never become evidence of absence.
    if (response.code !== 0) {
      const error = /An error occurred \(([^)]+)\) when calling the (\w+) operation:/.exec(response.stderr);
      const operation = service === "rds" ? "DescribeDBInstances" :
        command.operation.split("-").map(word => word.slice(0, 1).toUpperCase() + word.slice(1)).join("");
      result.classification = error?.[1] === command.absent && error?.[2] === operation ? "not-found" : "unresolved-query";
    } else {
      let records = response.value?.[command.list];
      if (!Array.isArray(records)) throw new Error("Malformed Describe");
      if (kind === "instance") {
        if (records.some((r: any) => !Array.isArray(r.Instances))) throw new Error("Malformed reservations");
        records = records.flatMap((r: any) => r.Instances);
      }
      if (records.some((r: any) => r?.[command.id] !== id)) throw new Error("Unexpected resource identity");
      if (records.length > 1) throw new Error("Duplicate resource identity");
      if (service === "rds" || kind === "natgateway") {
        if (response.value.Marker || response.value.NextToken) throw new Error("Incomplete Describe");
        if (service === "rds") {
          // A missing exact RDS identifier is documented as DBInstanceNotFound,
          // not an empty success response. RDS has no terminal "deleted" status.
          if (records.length !== 1 || records[0].DBInstanceArn !== arn ||
            !rdsLiveStates.has(records[0].DBInstanceStatus)) throw new Error("Malformed RDS Describe");
          result.classification = "live";
        } else if (records.length === 0) {
          result.classification = "not-found";
        } else if (records[0].State === "deleted") {
          result.classification = "terminated";
        } else {
          if (!natLiveStates.has(records[0].State)) throw new Error("Unknown NAT gateway state");
          result.classification = "live";
        }
      } else {
        result.classification = records.length === 0 ? "not-found" :
          kind === "instance" && records[0].State?.Name === "terminated" ? "terminated" : "live";
      }
    }
  } catch { result.classification = "unresolved-query"; }
  return result;
}

// Read original raw tag snapshots, never rewrite them or infer deletion from
// an ARN disappearing from a later inventory. Exact TestId tags scope evidence
// to this campaign set (including legacy snapshots without campaigns metadata).
export async function retainedInventoryArns(root: string, campaigns: string[], regions: readonly string[]) {
  const retained: Record<string, Set<string>> = Object.fromEntries(regions.map(region => [region, new Set<string>()]));
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name === "tagged.json") {
        const raw = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Array.isArray(raw.ResourceTagMappingList)) throw new Error("Malformed retained tag snapshot");
        // Runner snapshots nest region before label; verifier snapshots nest it after.
        const boundaries = path.relative(root, dir).split(path.sep).filter(part => regions.includes(part));
        if (boundaries.length !== 1) throw new Error("Retained snapshot region ambiguous");
        for (const resource of raw.ResourceTagMappingList) {
          if (!Array.isArray(resource.Tags) || typeof resource.ResourceARN !== "string") {
            throw new Error("Malformed retained resource identity");
          }
          if (!resource.Tags.some((tag: any) => tag?.Key === "TestId" && typeof tag.Value === "string")) {
            throw new Error("Retained resource campaign identity unavailable");
          }
          if (resource.Tags.some((tag: any) => tag.Key === "TestId" && campaigns.includes(tag.Value))) {
            retained[boundaries[0]!]!.add(resource.ResourceARN);
          }
        }
      }
    }
  }
  // Missing top-level evidence means no previous snapshots. Missing files
  // encountered during the traversal are failures, not an empty inventory.
  try { await fs.stat(root); }
  catch (error: any) { if (error.code === "ENOENT") return retained; throw error; }
  await visit(root);
  return retained;
}

export async function reconcileCleanup(inventories: Inventory[], regions: readonly string[],
  retained: Record<string, Set<string>>, account: string, query: AwsQuery, out: string) {
  inventories.forEach(validateInventory);
  const complete = regions.length === inventories.length &&
    regions.every(region => inventories.filter(i => i.region === region).length === 1);
  const classifications: Classification[] = [];
  for (const region of regions) {
    const current = inventories.find(i => i.region === region);
    const arns = new Set([...(retained[region] ?? []), ...(current?.taggedArns ?? [])]);
    for (const [index, arn] of [...arns].sort().entries()) {
      classifications.push(await classifyArn(region, arn, account, query, path.join(out, region, `direct-${index}.json`)));
    }
  }
  return {
    checkedAt: new Date().toISOString(), account, results: inventories, classifications,
    strictEmpty: complete && inventories.every(i => emptyLiveInventory(i) && !i.taggedArns.length),
    liveCleanupConfirmed: complete && /^\d{12}$/.test(account) && inventories.every(emptyLiveInventory) &&
      classifications.every(c => c.classification === "not-found" || c.classification === "terminated"),
  };
}

export function lockReleaseCriteria(input: {
  appliedSlots: number; emptyStates: number; cleanupErrors: string[];
  liveCleanupConfirmed: boolean; evidenceArchived: boolean; lockOwned: boolean;
}) {
  const criteria = {
    allAppliedStatesFreshlyEmpty: input.emptyStates === input.appliedSlots,
    noCleanupOrVerificationErrors: input.cleanupErrors.length === 0,
    directLiveCleanupConfirmed: input.liveCleanupConfirmed,
    evidenceArchived: input.evidenceArchived,
    lockOwned: input.lockOwned,
  };
  return { criteria, eligible: Object.values(criteria).every(Boolean) };
}

export async function releaseCleanupLock(io: Pick<HoldoutIO, "json">, lock: string, audit: string,
  input: Parameters<typeof lockReleaseCriteria>[0], expectedOwner = `${process.pid}\n`) {
  const owner = await fs.readFile(lock, "utf8");
  const decision = lockReleaseCriteria({ ...input, lockOwned: input.lockOwned && owner === expectedOwner });
  await io.json(audit, { at: new Date().toISOString(), expectedOwner: expectedOwner.trim(), ...decision });
  if (!decision.eligible) throw new Error("Cleanup lock release criteria not met; lock retained");
  if (await fs.readFile(lock, "utf8") !== expectedOwner) throw new Error("Cleanup lock ownership changed; lock retained");
  await fs.unlink(lock);
}

export function verifierArguments(args: string[]) {
  const [parent, campaign, ...flags] = args;
  if (typeof parent !== "string" || !/^typical-holdouts-v1-\d{8}$/.test(parent) ||
    typeof campaign !== "string" || !/^typical-(later-day|second-region)-\d{8}$/.test(campaign) ||
    flags.some(flag => flag !== "--classify")) {
    throw new Error("Use <parent ID> <exact campaign ID> [--classify]; direct classification is always enabled");
  }
  return { parent, campaign, root: path.resolve(".local/private-cwm-holdouts", parent) };
}
