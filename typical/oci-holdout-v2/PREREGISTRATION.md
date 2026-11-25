# oci-holdout-v2

This directory is the second **measured** OCI check and the first test of an OCI **calibration**. It reruns the oci-holdout-v1 harness, topology and ladder unchanged on **a later day than oci-holdout-v1** and scores it against predictions frozen **before any apply** from the engine's `oci-fit-v1` calibration.

**r1 and r2 of oci-holdout-v1 are fit data.** `oci-fit-v1` was fit to them: the per-rung mean of the two reps, piecewise-linear in log10(RPS) between rungs. They are used here only as in-sample evidence (`freeze/insample_check.py`), never as holdout results. This campaign does no fitting. Do not pool it with oci-holdout-v1 or with any AWS or GCP fit or holdout.

The **one factor that changes from oci-holdout-v1** is fresh applies on a later day than oci-holdout-v1 (both v2 reps may run the same day, back to back). The topology, ladder, timings, load script, parser, collect, cleanup, scoring weights and 95 floor are unchanged. Five **absolute tolerances** are declared below, **before any v2 data exists**: latency, app CPU, loss, throughput, and report-only DB extras. Composites under the unchanged v1 rule are reported alongside every v2 score. The runner soft cap is raised to $100, pause-to-ask.

Authority for the runner is this file, run from the pinned merged commit given in **Measurement pin**. A branch name is not a pin. When to act and when to ask is the **Runner standing approvals and decision table**; ask Kevin only for the items listed there.

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

`MySQL.2` is a current ECPU shape: 2 ECPU, 16 GiB. The published `/accuracy` OCI cell describes its database as "mysql-heatwave 2 OCPU E4.Flex"; that is the older OCPU naming of the same class and size. For the engine the database is sent as `serviceFamily: "mysql-heatwave"`, `size: "MySQL.2"`, `workloadDatabaseEngine: "mysql"`, `maxConnections: 1000`; the engine resolves it to tier `MySQL.2` with an *estimated* $0.106/hr. Without an explicit `maxConnections` the engine assumes **100** connections, which would bind at 500 and 1000 RPS, so the value is pinned in the create inputs.


## Ladder

One fresh apply per repetition. Kevin approved this spacing:

- **Same day, back to back.** The two reps (`r1`, `r2`) may run on the same day, one after the other. There is no 12-hour gap and no different-calendar-day requirement; those v1 rules do not apply to v2.
- **Between the reps:** r1's stack must be fully destroyed and cleanup verified before r2's fresh apply starts. Verified means `terraform destroy` succeeded with empty state, and the immediate compartment sweep shows no billable resource from r1 (Cleanup steps 1–2).
- **Fresh stack for r2:** r2 shares no resource, VM, LB or DB with r1.
- **24-hour checks:** each apply still gets its own 24-hour sweep, backup check and cost check (Cleanup step 3). They do not delay r2.
- **Later day than v1:** both reps run on a later day than oci-holdout-v1 (whose last steady window ended 2026-11-24T01:55Z = 2026-11-23 ET). Every v2 apply starts **at or after 2026-11-24T05:00:00Z (2026-11-24 00:00 ET)**, so it falls after 2026-11-23 in both ET and UTC.
  - Adapter 1.9.7 rejects v2 apply ids stamped before `20261124`.
  - Scoring rejects any v2 steady window that starts before 2026-11-24T05:00:00Z.
- **After the pin:** both reps also run after this prereg's PIN.md follow-up merges. On each apply the ladder is **10, then 100, then 500, then 1000** RPS (total, through the LB). Each rung is **300 s ramp/warmup + 900 s steady**. Do not change the order, the rates, or the durations. Each campaign (apply → destroy) is at most **3 hours**, and both campaigns together at most **6 resource-hours** of the scored stack plus generator.

Scenario keys are the oci-holdout-v1 keys, unchanged: `oci-holdout-10`, `oci-holdout-100`, `oci-holdout-500`, `oci-holdout-1000`. Each runs `load/oci-holdout.js` with `SCENARIO=<its own key>` (lean request function, byte-identical to `load/scenarios.js`; only the rate table `OCI_HOLDOUT_RPS` differs). The campaign is identified by the apply id, not the key. The key description string in `scripts/lib/adapter/scenarios.mjs` still says `oci-holdout-v1`; it is a label only and is deliberately not edited, so the harness stays byte-identical outside the apply-id rule.

Apply id: `oci-holdout-v2-r{1|2}-ad{1|2|3}[a|b|c]-YYYYMMDD`, where `YYYYMMDD` is the UTC date of the apply (as in v1), `ad{n}` is the availability domain actually used, and the optional letter marks a replacement apply on the same day. r1 and r2 on the same day are distinguished by `r1`/`r2`. Adapter 1.9.7 accepts `oci-holdout-v1-…` and `oci-holdout-v2-…` ids and rejects every other form (`TEST_ID_MISMATCH`). terraform/oci tags resources `campaign = oci-holdout-v2` for v2 ids.

| Rung | Lean rate twin | Role |
| --- | --- | --- |
| 10 | idle | Unloaded floor; fitted rung |
| 100 | normal | Light load; fitted rung |
| 500 | peak | Moderate load; fitted rung |
| 1000 | burst | Heavy load; fitted rung. LB bandwidth utilization is recorded |

All four rungs are fitted rungs, so this is a **replication** test of the calibration at the fitted loads on a later day, not an interpolation or extrapolation test.

## Frozen predictions

There is **one prediction set**: engine `oci-fit-v1` with `CWM_ENABLE_OCI_FIT_V1=true`. The flag is off in production; these predictions were produced on the engine build with it on. Predictions are not edited after the first apply. A later engine change does not rewrite this table. Machine-readable copy: `freeze/predictions.json`. Create inputs: `freeze/create-{10,100,500,1000}.json`, **byte-identical** to `../oci-holdout-v1/freeze/create-*.json` (same SHA-256).

- Source: `tests/fixtures/oci-fit-v1-frozen-predictions.json` in the engine repository, SHA-256 `6a735c8d9669e0fa1967fa4df3a3e4526ae7f55925c3fe31466d9fdcb697df03`.
- engineVersion `1.2.89`; revision `2f51870c2bdb`; evaluatorFingerprint `sha256:1b1ddeb714815be15df5a83c1a18895bf47a1e6861ad715963f8dde187b81340`; `ociFitPrediction.status` `fit-only` on all four rungs; calibration method `oci-fit-v1/log10-piecewise-means-v1`.
- With the flag off, the engine's outputs for these inputs are unchanged from 1.2.88 except `engineVersion` (engine test against hashes captured from 1.2.88). The 1.2.77 oci-holdout-v1 predictions remain frozen in `../oci-holdout-v1/freeze/predictions.json` and inside the engine's `oci-fit-v1` evidence.

| Rung | P50 ms | P95 ms | P99 ms | App CPU %/node | DB CPU % | DB conns | Throughput RPS | Total loss % | Hard errors % | $/hr (modeled) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 3.177 | 5.8155 | 9.381499999999999 | 0.5375 | 27.805 | 5 | 10 | 0 | 0 | 0.19 |
| 100 | 2.44 | 4.5905000000000005 | 5.775 | 1.4144999999999999 | 28.814999999999998 | 8.335 | 100 | 0 | 0 | 0.19 |
| 500 | 2.275 | 4.306 | 6.388 | 4.2715 | 33.39 | 15.58 | 500 | 0 | 0 | 0.19 |
| 1000 | 2.24 | 4.3055 | 7.443 | 4.7885 | 38.86 | 27.015 | 1000 | 0 | 0 | 0.23 |

Values are copied at stored precision. They equal the r1/r2 means of oci-holdout-v1 computed from the precision given to the engine (3 decimals for latency and CPU, 2 for DB CPU and connections); against the full-precision means in `measured.json` they differ by at most 0.0005 ms (latency), 0.0005 pp (app CPU), 0.0015 pp (DB CPU) and 0.0031 connections (rounding only). Cost is the engine's existing modeled estimate (headline rounded; app $0.0294 × 2, DB $0.106, LB $0.028, egress $0.036562 at 1000 RPS). It was not fitted.

| Rung | effectiveConfigHash (= predictionEffectiveConfigHash) | createInputSourceSha256 | createRequestBodySha256 |
| --- | --- | --- | --- |
| 10 | `9304e8afff0b7e64506fb05aab3d61160476492ddca17afb75741418dc22d83d` | `8743524823798941b9c52799b2c9d9136c18f7648972bfbe83467cedc9eeb721` | `2ba4ab078bb095953ed2796a4595116919c9e5dfde827eb0b5f3657110ec3d04` |
| 100 | `42d3693dc8edddea76eca79904fe1b1647deb95a590ac54fd136abe900a6e4d4` | `0f964e26edd08f2fe0384ce7665d8310da5817fa324dd8f3476fc95025f4f8fa` | `1428907b4ad08d661467147e8879b74e27237ab27f5c69c929febd60fb36246d` |
| 500 | `83fbbed4e3f23919b204eea0daf5656a144d40b6e1061f65a1dfd6463d88b261` | `54753927f6d4f66eb186d53b8fd103a13763c506900f793f8e2330b13dbe3b5e` | `c5e50313a7c8a15e7b2b8f397db55e679cdfa467538291c6a33e5e6a28800e24` |
| 1000 | `e792c8f9688d4290dc85fe4f9ed71959233865e92f02bb991b9a9a3085db0ca2` | `0cfa81f414ccb28a23335d51c05ed1a3953f666620be7f6ef56144c340a6e7e8` | `c78e236148f4bec8d6bb5e7a1d6ac7a460283ee204c561f33e72764af58d5f2a` |

`createInputSourceSha256` matches the SHA-256 of `freeze/create-<rps>.json` in this directory and in oci-holdout-v1.

### Price-list cross-check (not a prediction)

Same as oci-holdout-v1: scored stack (LB + 2 apps + DB + storage, no generator) ≈ **$0.25/hr** from the Oracle price list; full stack with generator ≈ **$0.33/hr**. oci-holdout-v1 reported spend about $3.39 for both reps including replacements.

## Verdicts

Each rep and rung is scored separately. **Per-rep results are primary.** A cross-rep mean for a rung is reported only when both reps measured that rung on a healthy apply.

### Measurement

- Latency: steady-only P50 / P95 / P99, nearest-rank from **raw k6 samples** over the 900 s steady window (`steady_p95.py` method). Ramp samples are excluded.
- Throughput: completed requests per second over the steady window.
- App CPU % (mean of the two app nodes) and DB CPU % from **OCI Monitoring**, steady window. DB connections avg and max from OCI Monitoring where the metric exists, else `null`.
- Cost: billed $/hr of the scored stack (no generator) from **OCI cost reports** for the run window. If cost reports do not cover the window, cost is `null`, **never zero**.
- Errors: record both **total request loss** (any request that did not complete with a 2xx, including k6 timeouts and dropped iterations; this is the scored error %) and **hard errors** (`http_req_failed`). Report per-class counts (HTTP status, timeout, connection reset/refused, dropped iteration) and a **whole-run** value that includes the ramp, alongside the steady value.


### Composite (the existing `/accuracy` formula, plus declared absolute tolerances)

**v1 rule (reported for every rung, unchanged):** `rel(sim, ref) = max(0, 100 − |sim − ref| / |ref| × 100)` against the measured value. Error % scores 100 if `|sim − ref| ≤ 0.01` percentage points, else `max(100 × 0.01 / |sim − ref|, rel)`. Weights: P50 0.20, P95 0.25, CPU 0.20, throughput 0.15, error 0.10, cost 0.10 (`typical/score.py`). If measured cost is `null`, the composite is reported **without cost** (the other five weights renormalized by 1/0.9), and labeled as such. A measured value of 0 follows the oci-holdout-v1 results convention (error `rel` part is 0).

**v2 rule (the verdict rule):** the v1 rule, except that a component scores **100** when the prediction is inside its absolute tolerance. Outside the tolerance, the v1 formula for that component applies unchanged. There is no partial credit, no taper, and no other change.

| Component | Weight | Scores 100 when | Otherwise |
| --- | --- | --- | --- |
| P50 ms | 0.20 | `\|pred − meas\| ≤ 0.5 ms` | `rel` |
| P95 ms | 0.25 | `\|pred − meas\| ≤ 0.5 ms` | `rel` |
| App CPU % (mean of the 2 app nodes) | 0.20 | `\|pred − meas\| ≤ 1.0 pp` | `rel` |
| Throughput RPS | 0.15 | `\|pred − meas\| / meas ≤ 0.5%` | `rel` |
| Total loss % (scored error) | 0.10 | `\|pred − meas\| ≤ 0.05 pp` | v1 error rule |
| Cost $/hr | 0.10 | no tolerance | `rel`; `null` → composite without cost |

Report-only extras use the same pattern. They are **not in the composite**: P99 within 0.5 ms, DB CPU within 2.0 pp, DB connections (average) within 5 connections, and hard errors within 0.05 pp. Each extra is reported under both rules.

Why each tolerance, from oci-holdout-v1, where two healthy applies of the identical stack were measured on consecutive days:

- **Latency:** P95 differed between reps by 0.41–0.52 ms per rung, and P50 by up to 0.09 ms. At a 4–6 ms scale, the v1 relative rule turns sub-millisecond k6 and network jitter into 8–12% errors. 0.5 ms is about one tenth of the measured P95.
- **App CPU:** the reps differed by 0.61–0.96 pp at 10–500 RPS on a 0.2–4.8% signal (72–263% relative at 10 RPS). That is OCI Monitoring and host noise, not model error.
- **Loss:** 0.05 pp is 1 failed request in 2,000. With 9,000–900,000 steady requests per rung, a handful of transient non-2xx responses would otherwise score 1–20 on error under the v1 rule.
- **Throughput:** sustained RPS was 99.95–100% of offered on every rung. 0.5% removes the 0.04–0.05-point rounding loss and nothing else; real shedding beyond 0.5% still scores `rel`.

**What these tolerances give away, stated plainly:**

- On this stack, **the composite becomes a band test.**
  - P50 and P95 are verified to ±0.5 ms. That is ±16–22% of P50 and ±8–12% of P95.
  - App CPU is verified to ±1 pp. That is ±21% or more even at 1000 RPS, so **CPU is a weak test at every rung**.
  - Loss is verified to ±0.05 pp.
- A pass means the calibrated engine reproduces this stack within those bands on a later day. It does **not** show the engine resolves latency or CPU more finely than that.

**Floor and verdict:**

- A rung **passes** when its v2 composite is **≥ 95%**.
- `oci-fit-v1` is reported as verified only if **every rung of both reps passes**. A partial pass is reported per rung and is not a verification.
- No rung is dropped.

**Other rules:**

- **Secondary P95 bands** on `|predicted − measured| / measured`: **pass** ≤ 20%, **marginal** > 20% and ≤ 35%, **fail** > 35%. Reported for every rung. Rungs with > 1% steady loss are flagged `saturated`.
- No fitting. No coefficient, weight, tolerance, or prediction changes after the first apply.

### In-sample and cross-rep scores (fit data, not a result)

`python3 typical/oci-holdout-v2/freeze/insample_check.py` writes `freeze/insample-scores.json`. Scores are composites without cost.

- **In-sample:** the frozen predictions scored against oci-holdout-v1 r1 and r2, which are the data they were fit to.
- **Cross-rep:** one v1 rep's measurements used as the prediction for the other rep. This is the best available stand-in for "the same stack on another day".

| Case | Rep | 10 | 100 | 500 | 1000 |
| --- | --- | --- | --- | --- | --- |
| In-sample, v1 rule | r1 | 90.65 | 90.35 | 95.90 | 98.23 |
| In-sample, v1 rule | r2 | 76.57 | 93.43 | 96.36 | 98.03 |
| In-sample, v2 rule | r1 | 100.00 | 100.00 | 100.00 | 100.00 |
| In-sample, v2 rule | r2 | 100.00 | 100.00 | 100.00 | 100.00 |
| Cross-rep, v1 rule (r2 predicts r1) | r1 | 81.32 | 80.71 | 91.82 | 96.47 |
| Cross-rep, v1 rule (r1 predicts r2) | r2 | 75.37 | 86.85 | 92.71 | 96.07 |
| Cross-rep, v2 rule (r2 predicts r1) | r1 | 100.00 | 100.00 | 100.00 | 96.84 |
| Cross-rep, v2 rule (r1 predicts r2) | r2 | 100.00 | 100.00 | 100.00 | 96.44 |

The in-sample v2 scores are 100 by construction: the frozen predictions are the two-rep means, so they sit inside every band.

The only cross-rep rung below 100 is **1000 RPS**. There the reps' P95 differed by 0.519 ms, just outside the 0.5 ms band, so P95 falls back to `rel` (87–89) and the composite is **96.4–96.8**. That is the closest any case comes to the floor.

### Expected outcome (stated before any apply)

**Expected result:** all eight v2-rule rungs pass if the stack behaves on the v2 day as it did on 2026-11-22/23 ET. Under the v1 rule, 10 and 100 RPS are expected to fail on app-CPU noise. They are reported anyway.

**What would still fail a rung under the v2 rule.** Each item below assumes everything else on the rung is exact:

- **Loss:** any steady total loss more than **0.05 pp** away from the predicted 0. At 0.06 pp the error score is 16.7, which drops the composite by about 9.3 points: a fail. This is the **largest single risk**. oci-holdout-v1 measured 0 on all 8 rungs, but a short LB or DB hiccup inside a steady window would fail that rung. It is a result, not a replacement (see Replacement).
- **P50** more than about 22.5% off, which fails the rung on its own. That is about 0.50 ms at 500–1000 RPS and 0.72 ms at 10 RPS. At 500–1000 RPS the 0.5 ms band and the fail point nearly coincide. P50 was stable in v1, with rep-to-rep gaps of 0.002–0.09 ms.
- **P95** more than about 18% off. That is roughly 0.78 ms at 1000 RPS and 1.0 ms at 10 RPS. Between 0.5 ms and that point the rung still passes.
- **App CPU** more than 1 pp off.
  - At 10 and 100 RPS, any excursion past 1 pp scores near 0 and fails the rung.
  - At 1000 RPS, a reading just above the band (about 5.8%) scores about 83 and passes. A reading just below it (about 3.8%) scores about 74 and fails.
- **Two components just outside their bands on the same rung,** for example P95 at 0.6 ms and CPU at 1.1 pp. That can fail a rung that neither would fail alone.
- **Cost, if billed cost becomes available.** The modeled $0.19–0.23/hr against about $0.25/hr billed scores 76–92 on cost, which lowers composites by about 0.4–2.4 points. Applied to the cases above, every in-sample and cross-rep composite stays at or above 96.0. It does narrow the margin for any other miss. Cost has no tolerance.

**Scope of a pass:** it verifies this topology at 10–1000 RPS in us-ashburn-1 within the stated bands. P99, DB CPU, DB connections and cost are reported, not verified.

## Replacement

A **runner fault** (terraform apply error, lost generator, control-plane failure, a collect that cannot read raw samples) replaces the **whole apply**. Do not re-run a single rung on that stack. Do not pool rungs across applies. At most **3** replacement applies per rep. A fourth fault **pauses and asks**.

A rep with a runner-side or infrastructure fault is an **invalid rep**, not a failed result. It is replaced automatically, up to **3** replacement applies per rep, and a fourth fault **pauses and asks**. Invalid-rep causes are limited to faults that can be shown **without looking at the scored metrics**:

- a Terraform apply or destroy error, or a control-plane or API failure;
- a stockout;
- the generator VM lost, or k6 exiting nonzero;
- raw k6 samples that cannot be collected;
- a steady window with fewer than 14 OCI Monitoring points for app CPU, which makes that metric unmeasurable;
- an OCI service incident for us-ashburn-1 Compute, Load Balancing, MySQL or Networking that OCI's public status or a support ticket confirms overlaps the steady window.

The runner records the cause and the evidence, and replaces the **whole apply**.

Workload errors, saturation, latency and slow rungs on a healthy apply are **results**. They do not authorize a replacement, even when they fail the rung. A rep is never replaced because of its scores.

### Stockouts and availability domains

- AD order is **AD-1, then AD-2, then AD-3**. An out-of-capacity error for any shape moves to the next AD with a fresh apply.
- A partially provisioned attempt is **destroyed and cleanup-verified** (the compartment search shows no billable resources from that apply) before the fresh apply.
- If all three ADs are out of capacity, **pause and ask**. Do not try other regions.
- Stockouts happen before any rung and are **excluded** from the two-consecutive-identical-deterministic-failure guard. If stockouts alone use the last replacement, pause and ask.
- Two consecutive applies that fail with the **same deterministic error** (not a stockout) **stop and report**.

### Control connection

SSH / control-connection drops are transient. The controller reconnects with backoff for up to about 10 minutes and **never stops k6**. A rung is lost only if the raw k6 samples cannot be collected; that is a runner fault.

## Spend

- Soft cap **$100** total for the campaign. At the cap, **pause and ask**. It never auto-stops, never destroys-and-continues, and never marks the campaign failed on its own.
- An **OCI Budget** on the `cwm-bench-oci` compartment with **alert-only** rules at **$15** and **$25** (unchanged Terraform). The budget takes no action, and these alerts are informational only. They are not the cap.
- Expected spend is about $2 (see price-list cross-check); the cap is a guard, not a forecast.

## Cleanup

1. `terraform destroy` with the same variables used to apply.
2. Immediately after: an `oci search` sweep of the `cwm-bench-oci` compartment for any remaining resource (instances, boot volumes, block volumes, LBs, DB systems, VCNs). Anything left is destroyed through Terraform where possible and documented.
3. Again **24 hours** later: the same sweep, plus a check that no MySQL backups exist for the DB system, plus a **Cost Analysis** check that charges stopped.


## Measurement pin

oci-holdout-v1 ran on `17376407cd8107732f35ba45785a9a06e10849a3` (PR #71 merge, adapter 1.9.6). That commit rejects `oci-holdout-v2-…` apply ids in the adapter and in `terraform/oci/variables.tf` (`TEST_ID_MISMATCH`, dry-run in the PR description). The scenario keys, ladder (10 → 100 → 500 → 1000, enforced), 300 s / 900 s timings and region are accepted unchanged.

This pull request's merge commit (adapter **1.9.7**) is the measurement pin. Relative to `17376407` it changes only:

- `OCI_HOLDOUT_TEST_ID_RE` and its error text in `scripts/lib/adapter/oci-catalog.mjs`, which accept `v1` or `v2`, plus a check that v2 apply-id stamps are `20261124` or later (v1 ids are unaffected);
- the `test_id` validation regex in `terraform/oci/variables.tf`, and the `campaign` tag, now derived from the apply id;
- `ADAPTER_VERSION`, tests, and documentation.

Load scripts, the parser, collect, cleanup, topology, timings and scoring code are byte-identical. A follow-up pull request writes the merge SHA into `PIN.md`. **The runner must not apply until that follow-up merges.** Before the first apply, the runner verifies `ADAPTER_VERSION` 1.9.7 at the pinned SHA, and that `git diff 17376407 <pin> -- load scripts/lib/adapter terraform/oci` touches only the files listed above.

## Code changes

Any change to measurement code, the load scripts, the adapter, Terraform, or the scoring rule after the pin is filled requires a **new version** (`oci-holdout-v2.1`, new pin) and fresh frozen predictions. Results from different pins or versions are never pooled. Runner-side launcher fixes outside cwm-bench are allowed only if they do not touch measurement, and their hash is recorded in the archive.

## Privacy

Archives and this directory contain no tenancy, user, or compartment OCID, API key, key fingerprint, or other account identifier. The compartment may be named (`cwm-bench-oci`) and, if needed, shown by its OCID suffix `…kghi7ge5q` only. Instance and resource identifiers appear only in redacted form.


## Runner standing approvals and decision table

This section is the complete list of when the runner acts and when it asks Kevin. It does not change the topology, ladder, timing, scoring, frozen predictions, or load-balancer bandwidth above. If a rule or row covers the situation, act on it; do not ask for confirmation of a listed action. Ask only for the items in the stop-and-ask list (item 13).

### Standing rules

**1. One go covers the whole campaign.** Kevin's single paid-run approval, given after this prereg and its PIN.md follow-up merge, covers r1 and r2, every allowed replacement, and all cleanup. Once that go is given, do not ask again before r2. Run r2 automatically **right after r1**, on the same day if possible. First destroy r1 and verify the immediate cleanup sweep is clean (no billable r1 resource left), then start r2 with a fresh apply. There is no 12-hour wait and no different-day requirement. r1's 24-hour sweep runs on its own schedule and does not block r2. Every v2 apply starts at or after 2026-11-24T05:00:00Z.

**2. Transient errors are retried automatically with backoff.** This covers API throttling, 5xx responses, and read timeouts. Control-connection or SSH drops reconnect with backoff for up to about 10 minutes. Never stop k6: it runs independently on the generator. After reconnecting, wait for the completion marker. Stop only if the generator VM is gone or k6 exits nonzero. Record each reconnect in the evidence.

**3. Stockouts** (E4 or MySQL.2 out of capacity) are AD-specific and transient:

- Destroy the partial stack and verify it is gone, then do a fresh apply in the next AD (AD-1, then AD-2, then AD-3).
- Record the AD used.
- Stockouts do not count toward the deterministic-error guard.
- Pause and ask only if stockouts alone use up the replacement allowance before any rung is measured, or if all three ADs are out.

**4. Deterministic errors.** If two consecutive attempts fail with the same deterministic error (quota, an API not enabled, permission, or validator), stop and report. Do not spend further replacements on it.

**5. Quota or limit exceeded.** Submit an OCI limit-increase request (to at least 2× the plan's need) and verify live headroom before the next apply. Never delete unrelated resources. Waiting on the request is a pause, not a failure, and not a reason to ask. If two consecutive apply attempts then fail with that same deterministic quota error, stop and report (item 4).

**6. Runner self-fixes are allowed without asking,** as long as they live outside cwm-bench and leave the protocol and measurements unchanged. This covers launcher or controller bugs, retries, state isolation, and archive splitting. Record the controller hash in the evidence. Any change to cwm-bench code needs a new pin pull request, which the runner delivers as a patch. The runner never edits the merged prereg.

**7. Version drift outside the prereg's pins** (OCI MySQL patch version, OS image patch, OCI provider patch): accept it if the major and minor versions match the prereg (MySQL 8.x, Node 20, k6 v0.54.0 exact), and record the exact versions. Anything else is a stop-and-ask.

**8. Faults and replacements.** A pre-rung, runner-side, or infrastructure fault (the invalid-rep causes listed under Replacement) means destroying the stack and replacing the whole apply automatically, up to 3 per rep. It is an invalid rep, not a failed result. A 4th pauses and asks. Workload errors and saturation are results, not faults: never retry a rung because of its results.

**9. Spend.** The $100 soft cap pauses and asks; it never auto-stops or destroys mid-rung. The budget alerts are informational only.

**10. Cleanup is fully autonomous.**

- After each campaign: destroy, run the sweep, run the sweep again 24 hours later, and check backups.
- Retry destroy-only cleanup every 2 hours until it is clean.
- Delete CWM simulations the runner creates.
- Only pause and ask if a resource still cannot be deleted after 24 hours.

**11. Evidence delivery.**

- Deliver results as archives, split into parts under 25 MB, each with sha256.
- Deliver code changes as patch files.
- Redact OCIDs, the key, the fingerprint, and account IDs (keep only the last 6 characters where an ID is needed).
- The runner never contacts GitHub.

**12. Ambiguity rule.** If something is not covered, follow this preregistration text first, then the gcp-holdout-v2 precedent. Record the deviation and the reasoning in the evidence, and continue. Only ask about what is listed in item 13.

**13. The complete list of reasons to stop and ask Kevin:**

- the paid go itself
- the cap being reached
- stockouts exhausting the replacements before a measurement, or all three ADs out
- a 4th replacement
- two consecutive identical deterministic errors
- version drift beyond the major/minor pins
- any change to the topology, ladder, timing, or scoring
- a resource that cannot be cleaned up after 24 hours
- anything that would require deleting resources the run did not create

### Decision table

| Situation | Action | Ask Kevin? |
| --- | --- | --- |
| Paid-run approval after this prereg and its PIN.md follow-up merge | This is the single go. It covers r1, r2, allowed replacements, and cleanup. Do not apply before it. | **Yes — this is the go** |
| r2 scheduling after r1 ends | Run automatically right after r1: destroy r1, verify the immediate sweep is clean, then do a fresh apply for r2 the same day. No 12-hour gap or different-day rule. If r1's cleanup is not verified, do not start r2; retry destroy-only cleanup per the cleanup row. | No |
| API throttling, 5xx, or read timeout | Retry automatically with backoff. | No |
| Control-connection or SSH drop | Reconnect with backoff for up to about 10 minutes. Never stop k6. After reconnecting, wait for the completion marker. Record the reconnect. | No |
| Generator VM gone, or k6 exits nonzero | Stop that attempt. Treat it as a runner fault and follow the replacement rule. | No, unless it is a 4th replacement |
| E4 or MySQL.2 stockout | Destroy the partial stack, verify it is gone, then a fresh apply in the next AD (AD-1 → AD-2 → AD-3). Record the AD. Do not count it toward the deterministic-error guard. | No, unless stockouts alone exhaust replacements before any rung is measured, or all three ADs are out |
| Quota or limit exceeded | Submit an OCI limit-increase request to at least 2× the plan's need. Verify live headroom before the next apply. Never delete unrelated resources. Waiting is a pause, not a failure, and not a reason to ask. | No |
| Two consecutive identical deterministic errors (quota, API not enabled, permission, or validator) | Stop and report. Do not spend further replacements. | **Yes** |
| Runner-side launcher/controller bug, retry, state isolation, or archive split that lives outside cwm-bench and does not change the protocol or measurements | Self-fix without asking. Record the controller hash in the evidence. | No |
| Change to cwm-bench code | Deliver a patch for a new pin pull request. Never edit the merged prereg. | No — deliver the patch; do not edit the repo |
| Version drift that still matches the major/minor pins (MySQL 8.x, Node 20, k6 v0.54.0 exact) | Accept it. Record the exact versions. | No |
| Version drift beyond those pins | Stop and report. | **Yes** |
| Pre-rung or runner-side fault | Destroy the stack and replace the whole apply, up to 3 per rep. | No for the 1st–3rd; **Yes** for a 4th |
| Workload errors, saturation, or a slow rung | Record as results. Never retry a rung because of its results. | No |
| $100 soft cap reached | Pause. Do not auto-stop or destroy mid-rung. Budget alerts are informational only. | **Yes** |
| Cleanup after each campaign | Destroy, sweep, sweep again 24 hours later, and check backups. Retry destroy-only cleanup every 2 hours until clean. Delete CWM simulations the runner created. | No, unless a resource still cannot be deleted after 24 hours (**Yes**) |
| Evidence and patches | Archives split into parts under 25 MB, each with sha256. Code changes as patch files. Redact OCIDs, the key, the fingerprint, and account IDs to the last 6 characters. Never contact GitHub. | No |
| Situation not covered here | Follow this preregistration first, then the gcp-holdout-v2 precedent. Record the deviation and the reasoning, and continue. | No, unless it is one of the stop-and-ask items |
| Change to the topology, ladder, timing, or scoring | Do not make the change. | **Yes** |
| Deleting resources the run did not create | Do not delete them. | **Yes** |

