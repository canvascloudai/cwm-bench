// No AWS, database, or CWM calls. Invokes the pinned public collector against injected fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { P95 } from "./cwm-bench-p95-contract";

async function main() {
  const repo = process.argv[2], out = process.argv[3];
  if (!repo || !out) throw new Error("Provide pinned checkout and private dry-run output directory");
  const { main: adapter } = await import(pathToFileURL(path.join(repo, "scripts/lib/adapter/main.mjs")).href);
  const { MemoryStream, createAwsMock, ssmOnlineHandlers, terraformOutputFixture } =
    await import(pathToFileURL(path.join(repo, "tests/helpers.mjs")).href);
  const scenario = "typical-p95-1x-300", campaignId = "typical-p95-1x-r1-20261010", runId = `${scenario}-r1`;
  const summary = { metrics: {
    http_req_duration: { values: { avg: 10, "p(50)": 10, "p(90)": 10, "p(95)": 10, "p(99)": 10, max: 10 } },
    http_reqs: { values: { count: 360000, rate: 300 } },
    http_req_failed: { values: { rate: 0, passes: 0, fails: 360000 } },
    dropped_iterations: { values: { count: 0 } }, vus_max: { values: { max: 80, value: 80 } },
  } };
  const listing = [`ARTIFACT_DIR=/opt/cwm-bench/results/raw/${campaignId}/${runId}`,
    "summary.json", "k6.json.gz", "identity.json", "---SUMMARY_JSON---", JSON.stringify(summary),
    "---END_SUMMARY_JSON---", "---IDENTITY_JSON---", JSON.stringify({ campaignId, runId, scenario }),
    "---END_IDENTITY_JSON---"].join("\n");
  const aws = createAwsMock({
    ...ssmOnlineHandlers({ meta: { poolSize: 250, profile: "typical", workers: 2, gitSha: P95.revision } }),
    "ssm.get-command-invocation": async () => ({ code: 0, stdout: JSON.stringify({
      Status: "Success", StandardOutputContent: listing, StandardErrorContent: "", ResponseCode: 0 }), stderr: "" }),
  });
  const stdout = new MemoryStream(), stderr = new MemoryStream();
  const code = await adapter(["collect", "--scenario", scenario, "--json"], {
    stdout, stderr, now: () => new Date("2026-10-10T10:21:00.000Z"),
    deps: {
      runAws: aws,
      runTerraform: async () => ({ code: 0, stdout: terraformOutputFixture({
        app_instance_ids: { value: ["i-dryrun"] },
        app_root_volume_ids: { value: ["vol-dryrun"] },
        topology_declaration: { value: { region: "us-east-2", test_id: campaignId, app_count: 1,
          app_pool_size: 250, mysql_max_connections: 500, app_instance_type: "m5.large",
          db_instance_class: "db.r5.large", db_engine: "mysql", db_multi_az: false,
          generator_instance_type: "c6i.xlarge", alb: "application" } },
      }), stderr: "" }),
      fs: { readFile: async () => { throw Object.assign(new Error("No fixture state"), { code: "ENOENT" }); },
        writeFile: async () => {}, mkdir: async () => {} },
    },
    env: { CWM_CAMPAIGN_ID: campaignId, CWM_SCENARIO: scenario, CWM_RUN_ID: runId,
      CWM_MEASUREMENT_SHA: P95.revision, CWM_RUN_STARTED_AT: "2026-10-10T10:00:00Z",
      CWM_RUN_ENDED_AT: "2026-10-10T10:20:00Z" },
  });
  const collect = JSON.parse(stdout.toString());
  assert.equal(collect.adapterVersion, P95.version);
  assert.equal(collect.artifacts.identityMatches, true);
  assert.equal(collect.latency.untaggedAggregate, true);
  const explicitSha = collect.measurementSha ?? collect.terraformOutputs?.topology_declaration?.app_source_git_ref;
  assert.equal(collect.measurementSha, P95.revision, "Collect JSON must export the exact approved merge SHA");
  const evidence = {
    syntheticFixtureOnly: true, noAwsOrDatabaseOrCwmCalls: true, pinnedSha: P95.revision,
    adapterVersion: collect.adapterVersion, adapterExitCode: code,
    suppliedCwmMeasurementSha: true, explicitCollectMeasurementShaPresent: Boolean(explicitSha),
    measurementSha: collect.measurementSha,
    blocker: !explicitSha ? "Pinned collector does not export measurement SHA; preregistered identity validator requires it" : null,
    noScoringPerformed: true,
  };
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(out, "synthetic-collect.json"), JSON.stringify(collect, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(out, "provenance-preflight.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(() => { console.error("No-AWS provenance fixture failed; no resources provisioned"); process.exitCode = 1; });
