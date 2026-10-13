import path from "node:path";
import { ScaleCloud } from "./cwm-bench-scale-cloud";
import { validateInventory, type Inventory } from "./cwm-bench-holdout-cleanup";

// External P95 wiring only; frozen historical controllers remain unchanged.
export class P95Cloud extends ScaleCloud {
  override async inventory(region: string, campaigns: string[], out: string): Promise<Inventory> {
    if (!campaigns.length || campaigns.some(id => typeof id !== "string" || !id.length))
      throw new Error("Cleanup requires nonempty campaign identifiers");
    if (campaigns.length <= 20) return super.inventory(region, campaigns, out);
    const batches: Inventory[] = [];
    for (let offset = 0; offset < campaigns.length; offset += 20) {
      batches.push(await super.inventory(region, campaigns.slice(offset, offset + 20),
        path.join(out, `batch-${String(offset / 20 + 1).padStart(3, "0")}`)));
    }
    const union = (key: "taggedArns" | "liveInstanceIds" | "volumeIds" | "ruleIds" | "rdsIds") =>
      [...new Set(batches.flatMap(batch => batch[key]))];
    const result: Inventory = {
      region, checkedAt: new Date().toISOString(), campaigns: [...campaigns],
      taggedArns: union("taggedArns"), liveInstanceIds: union("liveInstanceIds"),
      volumeIds: union("volumeIds"), ruleIds: union("ruleIds"), rdsIds: union("rdsIds"),
    };
    validateInventory(result);
    await this.io.json(path.join(out, region, "batch-coverage.json"), {
      maxTagFilterValues: 20, campaigns, batches: batches.map(batch => batch.campaigns),
      everyIdChecked: batches.flatMap(batch => batch.campaigns).join("\0") === campaigns.join("\0"),
    });
    await this.io.json(path.join(out, region, "summary.json"), result);
    return result;
  }
}
