import fs from "node:fs/promises";
import { classifyArn, emptyLiveInventory, type AwsQuery, reconcileCleanup } from "./cwm-bench-holdout-cleanup";

type Proof = Awaited<ReturnType<typeof reconcileCleanup>>;

/** Retry only a timed-out read, never a load, apply, permission error or live resource. */
export async function retryTimedOutCleanupReads(
  proof: Proof,
  query: AwsQuery,
  saveInitial: (proof: Proof) => Promise<void>,
  readStderr: (file: string) => Promise<string> = file => fs.readFile(file, "utf8"),
): Promise<Proof> {
  const retryable: number[] = [];
  for (const [index, c] of proof.classifications.entries()) {
    if (c.classification !== "unresolved-query" || !c.evidenceFile) continue;
    if (/^COMMAND_TIMEOUT$/m.test(await readStderr(`${c.evidenceFile}.stderr.txt`))) retryable.push(index);
  }
  if (!retryable.length) return proof;
  await saveInitial(proof);
  const classifications = [...proof.classifications];
  for (const index of retryable) {
    const c = classifications[index];
    if (!c.evidenceFile?.endsWith(".json")) throw new Error("Retry evidence path unavailable");
    classifications[index] = await classifyArn(c.region, c.arn, proof.account, query,
      c.evidenceFile.replace(/\.json$/, "-attempt2.json"));
  }
  const complete = proof.results.length === 2 &&
    ["us-east-2", "us-west-2"].every(region => proof.results.filter(i => i.region === region).length === 1);
  return {
    ...proof, checkedAt: new Date().toISOString(), classifications,
    liveCleanupConfirmed: complete && /^\d{12}$/.test(proof.account) &&
      proof.results.every(emptyLiveInventory) &&
      classifications.every(c => c.classification === "not-found" || c.classification === "terminated"),
  };
}
