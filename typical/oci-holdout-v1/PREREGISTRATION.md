# oci-holdout-v1

This directory is the first **measured** OCI check. Today the OCI cell on `/accuracy` is a documentation-reference comparison, not a measurement; OCI accuracy is **unverified**. This campaign measures a real OCI stack and scores it against predictions frozen **before any apply**. It is a holdout: nothing here was fit to OCI measurements, and no fitting happens in this campaign. Do not pool it with any AWS or GCP fit or holdout.

If a calibration follows, r1 and r2 of this campaign become **fit data** and a new OCI holdout (new directory, new pin, new frozen predictions) is required before any accuracy claim. Results from different pins are never pooled.

Authority for the runner is this file, run from the pinned merged commit given in **Measurement pin**. A branch name is not a pin. **No apply is allowed on this pull request's merge commit** (see Measurement pin).

## Topology

| Piece | Value |
| --- | --- |
| Region | `us-ashburn-1`. Availability domain chosen by the stockout rule below and **recorded per rep** |
| Target compartment | `cwm-bench-oci` under the CCAI tenancy (OCID suffix `…kghi7ge5q`). In the repo it is a **variable only** |
| Load balancer | Public OCI Flexible Load Balancer, 10–100 Mbps, HTTP:80 |
| App | 2 × `VM.Standard.E4.Flex`, 2 OCPU / 16 GB each, Node 20, lean app (`app/`), `APP_POOL_SIZE=250`, 1 worker, same seed as the AWS lean stack |
| Database | MySQL HeatWave DB system, shape **`MySQL.2`** (2 ECPU / 16 GiB), standalone. **HeatWave cluster disabled** (explicitly, not by default), HA off, 100 GiB storage, `max_connections=1000` (Oracle default for this shape; the applied value is read back and recorded), automatic backups off, delete protection off, skip final backup |
| Generator | 1 × `VM.Standard.E4.Flex` 2 OCPU / 16 GB, k6 **v0.54.0**, same AD as the app tier |

Tenancy, user, and compartment OCIDs, the API key, its fingerprint, and any other account identifier are variables supplied at run time from the runner's saved OCI connection. This repo does not commit them.

### MySQL.2 mapping

`MySQL.2` is a current ECPU shape: 2 ECPU, 16 GiB. The published `/accuracy` OCI cell describes its database as "mysql-heatwave 2 OCPU E4.Flex"; that is the older OCPU naming of the same class and size. For the live engine (Set B) the database is sent as `serviceFamily: "mysql-heatwave"`, `size: "MySQL.2"`, `workloadDatabaseEngine: "mysql"`, `maxConnections: 1000`; the engine resolves it to tier `MySQL.2` with an *estimated* $0.106/hr. Without an explicit `maxConnections` the engine assumes **100** connections, which would bind at 500 and 1000 RPS, so the value is pinned in the create inputs.

## Ladder

One fresh apply per repetition. Two reps (`r1`, `r2`) on **different UTC days**. On each apply the ladder is **10, then 100, then 500, then 1000** RPS (total, through the LB). Each rung is **300 s ramp/warmup + 900 s steady**. Do not change the order, the rates, or the durations. Each campaign (apply → destroy) is at most **3 hours**, and both campaigns together at most **6 resource-hours** of the scored stack plus generator.

Scenario keys: `oci-holdout-10`, `oci-holdout-100`, `oci-holdout-500`, `oci-holdout-1000`. Each runs `load/oci-holdout.js` with `SCENARIO=<its own key>`. That script's request function is **byte-identical** to the lean `load/scenarios.js` (70% `GET /api/products/:id`, 20% `GET /api/products`, 10% `POST /api/orders`); only the rate table (`OCI_HOLDOUT_RPS` in `load/lib/common.js`) and the scenario identity differ, so an OCI run is never labeled as an AWS lean rung. Tests enforce the byte identity. The lean files themselves are unchanged.

Apply id: `oci-holdout-v1-r{1|2}-ad{1|2|3}[a|b|c]-YYYYMMDD`, where `ad{n}` is the availability domain actually used and the optional letter marks a replacement apply on the same day. The adapter rejects any other form (`TEST_ID_MISMATCH`).

| Rung | Lean rate twin | Role |
| --- | --- | --- |
| 10 | idle | Unloaded latency floor |
| 100 | normal | Light load |
| 500 | peak | Moderate load; Set A predicts > 1% loss here |
| 1000 | burst | Heavy load; tests saturation predictions. The 100 Mbps LB cap may bind here depending on response size; LB bandwidth utilization is recorded |

## Frozen predictions

Two prediction sets are frozen. They are **scored separately and never combined**. Set A is what `/accuracy` publishes and scores for OCI. Set B is what an MCP user gets from the live engine for this exact topology. They disagree strongly (Set A P95 46–297 ms; Set B P95 5 ms flat); that disagreement is itself a finding and is reported. Predictions are not edited after the first apply. A later engine change does not rewrite these tables. Machine-readable copies, create inputs, and the raw `/accuracy` response are in `freeze/`.

### Set A — published `/accuracy` OCI cell

- Source: `GET https://www.cloudworldmodel.ai/api/accuracy-benchmark?provider=oci`, fetched `2026-11-17T02:05:31Z` (2026-11-16 9:05 PM ET); response `generatedAt` `2026-11-17T02:05:37.612Z`, seed `20240601`, overall score 90.
- Saved response: `freeze/accuracy-oci-20261117T0205Z.json`, SHA-256 `dd16b96f3b2446ac4e1ecf663c4274720e1db5df906fd9b909b566caf7c9b292`.
- The cell publishes no P99, DB CPU, or DB connections; those are not scored for Set A.

| Rung | P50 ms | P95 ms | App CPU % | Throughput RPS | Error % | $/hr |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 21 | 46 | 4.3 | 9.989 | 0.11 | 0.249968 |
| 100 | 32 | 67 | 12.1 | 99.704614 | 0.295 | 0.249968 |
| 500 | 83 | 162 | 44.4 | 486.845 | 2.631 | 0.249968 |
| 1000 | 155 | 297 | 82.6 | 883.00814 | 11.699 | 0.249968 |

### Set B — live engine via MCP (owned simulations)

- Engine version `1.2.77`; revision `fb400b40135f`; evaluator fingerprint `sha256:f0b60f6be776ed681c61e0e77ba09eaca2b627564b5c69ac3fd1a161e3566712` (both as reported in the engine's `gcpFitPrediction.implementation` block, the only revision it exposes).
- `scenarioHash` `1c3236de75c42171b18e3133abf862fd950e84225ffad4a8caa6f0054dadd1e3` (all four); replay `effectiveConfigHash` `7b489a10498e72fd81d6b5ac03374e91a9d71827d73ba4c6639c08efea83d357`.
- Created `2026-11-17T02:07Z`, read `2026-11-17T02:08Z` (2026-11-16 9:07–9:08 PM ET). Protocol: `simulation.create` (runs 5 steps), step 20, step 60, read metrics at step 85; the 60-step history was flat. All simulations were deleted after the read.
- Inputs: `appWeight: lean`, seed `20240601`, min/max instances 2, LB `serviceFamily: oci-lb`; apps `size: "VM.Standard.E4.Flex (2 OCPU)"`, `serviceFamily: oci-compute`, autoscaling off, `workload: crud`, Node `"20"`, 1 worker, pool 250; database as in **MySQL.2 mapping**; all in `us-ashburn-1` AD-1. Exact inputs: `freeze/create-{10,100,500,1000}.json`.
- Coverage: `modeled`, load scope **not calibrated**. P50/P95 come from a generic internal-LB baseline; P99 is labeled uncalibrated by the engine. Losses are admission/pool-saturation; no `rampAveragingShortfallPct` is reported. Every cost line is `estimated` (app $0.0294 each, DB $0.106, LB $0.028; plus $0.03543 egress at 1000 RPS).

| Rung | P50 ms | P95 ms | P99 ms | App CPU %/node | DB CPU % | DB conns | Throughput RPS | Total loss % | Hard errors % | $/hr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 5 | 5 | 140 | 0.196 | 1 | 2 | 9.999992 | 0.00008 | 0 | 0.1928 |
| 100 | 5 | 5 | 237 | 0.95 | 1 | 20 | 99.99176 | 0.00824 | 0 | 0.1928 |
| 500 | 5 | 5 | 773 | 4.305 | 5.4 | 100 | 498.97 | 0.206 | 0 | 0.1928 |
| 1000 | 5 | 5 | 1686 | 8.499 | 14.3 | 200 | 991.76 | 0.824 | 0 | 0.22823 |

| Rung | Simulation (deleted) | effectiveConfigHash | Create input SHA-256 |
| --- | --- | --- | --- |
| 10 | `9d3aaae3` | `4a0e7aa679902f7d350d2b5afa7c84519ad4946854a8c67cc54f35143ce19f8b` | `8743524823798941b9c52799b2c9d9136c18f7648972bfbe83467cedc9eeb721` |
| 100 | `b60b2a54` | `751173184829b163d71ede5460acff1b779a1d46581b6dffbc7afcaf5e40ac66` | `0f964e26edd08f2fe0384ce7665d8310da5817fa324dd8f3476fc95025f4f8fa` |
| 500 | `9737f895` | `d6c5ea5900c64dddaf180dc442d6001e3b04703c406dc8cf1875f1a5373a91fa` | `54753927f6d4f66eb186d53b8fd103a13763c506900f793f8e2330b13dbe3b5e` |
| 1000 | `d6ec3a4b` | `e547d9a78c68cff7de0c84b4cca5030119f892250e8a582d6d55c54279e0482a` | `0cfa81f414ccb28a23335d51c05ed1a3953f666620be7f6ef56144c340a6e7e8` |

### Price-list cross-check (not a prediction)

Oracle price list (last updated 2026-11-02, pay-as-you-go USD): E4 OCPU $0.025/OCPU-hr and memory $0.0015/GB-hr give **$0.074/hr** per 2 OCPU/16 GB VM; MySQL ECPU $0.0366/ECPU-hr gives **$0.0732/hr** for `MySQL.2`; storage $0.04/GB-month (100 GB ≈ $0.0054/hr); LB base $0.0113/hr plus bandwidth $0.0001/Mbps-hr (free-tier allowances may zero both). Scored stack (LB + 2 apps + DB + storage, no generator) ≈ **$0.25/hr**; full stack with generator and boot volumes ≈ **$0.33/hr**; 6 resource-hours ≈ **$2**.

## Verdicts

Each rep and rung is scored separately. **Per-rep results are primary.** A cross-rep mean for a rung is reported only when both reps measured that rung on a healthy apply.

### Measurement

- Latency: steady-only P50 / P95 / P99, nearest-rank from **raw k6 samples** over the 900 s steady window (`steady_p95.py` method). Ramp samples are excluded.
- Throughput: completed requests per second over the steady window.
- App CPU % (mean of the two app nodes) and DB CPU % from **OCI Monitoring**, steady window. DB connections avg and max from OCI Monitoring where the metric exists, else `null`.
- Cost: billed $/hr of the scored stack (no generator) from **OCI cost reports** for the run window. If cost reports do not cover the window, cost is `null`, **never zero**.
- Errors: record both **total request loss** (any request that did not complete with a 2xx, including k6 timeouts and dropped iterations; this is the scored error %) and **hard errors** (`http_req_failed`). Report per-class counts (HTTP status, timeout, connection reset/refused, dropped iteration) and a **whole-run** value that includes the ramp, alongside the steady value.

### Composite (the existing `/accuracy` formula)

Per rung and per set: `rel(sim, ref) = max(0, 100 − |sim − ref| / |ref| × 100)` against the measured value. Error % scores 100 if `|sim − ref| ≤ 0.01` percentage points, else `max(100 × 0.01 / |sim − ref|, rel)`. Weights: P50 0.20, P95 0.25, CPU 0.20, throughput 0.15, error 0.10, cost 0.10 (`typical/score.py`). If measured cost is `null`, the composite is reported **without cost** (the other five weights renormalized by 1/0.9), and labeled as such.

- **Floor:** a rung **passes** when its composite is **≥ 95%**. OCI is reported as verified for a set only if every rung of both reps passes for that set.
- **Secondary P95 bands** on `|predicted − measured| / measured`: **pass** ≤ 20%, **marginal** > 20% and ≤ 35%, **fail** > 35%. Reported for every rung; latency is not withheld at high error, but rungs with > 1% steady loss are flagged `saturated`.
- Set B extras (P99, DB CPU, DB connections, hard errors) are reported as predicted vs measured with the same `rel`; they are not in the composite.
- No fitting. No coefficient, weight, or prediction changes after the first apply.

## Replacement

A **runner fault** (terraform apply error, lost generator, control-plane failure, a collect that cannot read raw samples) replaces the **whole apply**. Do not re-run a single rung on that stack. Do not pool rungs across applies. At most **3** replacement applies per rep. A fourth fault **pauses and asks**.

Workload errors, saturation, and slow rungs are **results**. They do not authorize a replacement.

### Stockouts and availability domains

- AD order is **AD-1, then AD-2, then AD-3**. An out-of-capacity error for any shape moves to the next AD with a fresh apply.
- A partially provisioned attempt is **destroyed and cleanup-verified** (the compartment search shows no billable resources from that apply) before the fresh apply.
- If all three ADs are out of capacity, **pause and ask**. Do not try other regions.
- Stockouts happen before any rung and are **excluded** from the two-consecutive-identical-deterministic-failure guard. If stockouts alone use the last replacement, pause and ask.
- Two consecutive applies that fail with the **same deterministic error** (not a stockout) **stop and report**.

### Control connection

SSH / control-connection drops are transient. The controller reconnects with backoff for up to about 10 minutes and **never stops k6**. A rung is lost only if the raw k6 samples cannot be collected; that is a runner fault.

## Spend

- Soft cap **$25** total for the campaign. At the cap, **pause and ask**. It never auto-stops, never destroys-and-continues, and never marks the campaign failed on its own.
- An **OCI Budget** on the `cwm-bench-oci` compartment with **alert-only** rules at **$15** and **$25**. The budget takes no action.
- Expected spend is about $2 (see price-list cross-check); the cap is a guard, not a forecast.

## Cleanup

1. `terraform destroy` with the same variables used to apply.
2. Immediately after: an `oci search` sweep of the `cwm-bench-oci` compartment for any remaining resource (instances, boot volumes, block volumes, LBs, DB systems, VCNs). Anything left is destroyed through Terraform where possible and documented.
3. Again **24 hours** later: the same sweep, plus a check that no MySQL backups exist for the DB system, plus a **Cost Analysis** check that charges stopped.

## Measurement pin

Current `main` at freeze time is `b0740e20` (adapter **1.7.5**). That checkout has **no OCI keys**: `run --scenario oci-holdout-10` returns `UNKNOWN_SCENARIO` (the `gcp-holdout-v1` PR #57 failure mode).

This pull request's merge commit (adapter **1.8.0**) registers the four keys, the ladder, region, timings, and apply-id rule, and **refuses** every OCI run and collect with `OCI_HARNESS_NOT_PINNED` before any cloud call. It has no OCI Terraform and no OCI collector. **Do not apply on this commit.**

The measurement pin is the **merge commit of the OCI harness pull request** (`terraform/oci`, `scripts/lib/adapter/oci.mjs`, OCI cleanup sweep and cleanup-compat entry, tests). The runner **must not apply** until a follow-up pull request writes that merge commit into this section. That follow-up changes no prediction, rung, duration, or scoring rule above.

## Code changes

Any change to measurement code, the load scripts, the adapter, Terraform, or the scoring rule after the harness pin is filled requires a **new version** (`oci-holdout-v1.1`, new pin) and fresh frozen predictions. Results from different pins or versions are never pooled. Runner-side launcher fixes outside cwm-bench are allowed only if they do not touch measurement, and their hash is recorded in the archive.

## Privacy

Archives and this directory contain no tenancy, user, or compartment OCID, API key, key fingerprint, or other account identifier. The compartment may be named (`cwm-bench-oci`) and, if needed, shown by its OCID suffix `…kghi7ge5q` only. Instance and resource identifiers appear only in redacted form.
