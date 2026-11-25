# oci-holdout-v2

This directory is the second **measured** OCI check and the first test of an OCI **calibration**. It reruns the oci-holdout-v1 harness, topology and ladder unchanged on **new days** and scores it against predictions frozen **before any apply** from the engine's `oci-fit-v1` calibration.

**r1 and r2 of oci-holdout-v1 are fit data.** `oci-fit-v1` was fit to them: the per-rung mean of the two reps, piecewise-linear in log10(RPS) between rungs. They are used here only as in-sample evidence (`freeze/insample_check.py`), never as holdout results. This campaign does no fitting. Do not pool it with oci-holdout-v1 or with any AWS or GCP fit or holdout.

The **one factor that changes from oci-holdout-v1** is fresh applies on new calendar days. The topology, ladder, timings, load script, parser, collect, cleanup, scoring weights and 95 floor are unchanged. One scoring addition is declared below, **before any v2 data exists**: a 1 percentage-point absolute tolerance for app CPU.

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

One fresh apply per repetition. Two reps (`r1`, `r2`) on **different UTC days** and **different America/New_York days**, r2 at least 12 hours after r1 ends. Both reps run after this prereg's PIN.md follow-up merges, so neither falls on 2026-11-22 or 2026-11-23 ET (the fit days). On each apply the ladder is **10, then 100, then 500, then 1000** RPS (total, through the LB). Each rung is **300 s ramp/warmup + 900 s steady**. Do not change the order, the rates, or the durations. Each campaign (apply → destroy) is at most **3 hours**, and both campaigns together at most **6 resource-hours** of the scored stack plus generator.

Scenario keys are the oci-holdout-v1 keys, unchanged: `oci-holdout-10`, `oci-holdout-100`, `oci-holdout-500`, `oci-holdout-1000`. Each runs `load/oci-holdout.js` with `SCENARIO=<its own key>` (lean request function, byte-identical to `load/scenarios.js`; only the rate table `OCI_HOLDOUT_RPS` differs). The campaign is identified by the apply id, not the key. The key description string in `scripts/lib/adapter/scenarios.mjs` still says `oci-holdout-v1`; it is a label only and is deliberately not edited, so the harness stays byte-identical outside the apply-id rule.

Apply id: `oci-holdout-v2-r{1|2}-ad{1|2|3}[a|b|c]-YYYYMMDD`, where `ad{n}` is the availability domain actually used and the optional letter marks a replacement apply on the same day. Adapter 1.9.7 accepts `oci-holdout-v1-…` and `oci-holdout-v2-…` ids and rejects every other form (`TEST_ID_MISMATCH`). terraform/oci tags resources `campaign = oci-holdout-v2` for v2 ids.

| Rung | Lean rate twin | Role |
| --- | --- | --- |
| 10 | idle | Unloaded floor; fitted rung |
| 100 | normal | Light load; fitted rung |
| 500 | peak | Moderate load; fitted rung |
| 1000 | burst | Heavy load; fitted rung. LB bandwidth utilization is recorded |

All four rungs are fitted rungs, so this is a **replication** test of the calibration at the fitted loads on new days, not an interpolation or extrapolation test.

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


### Composite (the existing `/accuracy` formula, plus one declared CPU tolerance)

Per rung: `rel(sim, ref) = max(0, 100 − |sim − ref| / |ref| × 100)` against the measured value. Error % scores 100 if `|sim − ref| ≤ 0.01` percentage points, else `max(100 × 0.01 / |sim − ref|, rel)`. Weights: P50 0.20, P95 0.25, CPU 0.20, throughput 0.15, error 0.10, cost 0.10 (`typical/score.py`). If measured cost is `null`, the composite is reported **without cost** (the other five weights renormalized by 1/0.9), and labeled as such. A measured value of 0 follows the oci-holdout-v1 results convention (error `rel` part is 0).

- **App CPU tolerance (new, declared before any v2 data):** the CPU component scores **100** when `|predicted − measured| ≤ 1.0` percentage point (app CPU %, mean of the two app nodes); otherwise the existing `rel` applies unchanged. Reason: measured app CPU on this stack is 0.2–4.8%, and two healthy applies of the identical stack differed by 0.61 pp at 10 RPS (0.84% vs 0.23%), which is 72–263% in relative terms. A relative score there measures OCI Monitoring noise, not the model. The tolerance applies to app CPU only. P50, P95, throughput, error and cost are unchanged. Both the v1-rule and v2-rule composites are reported for every rung; **the verdict uses the v2 rule.**
- What the tolerance gives away: on this stack every rung's measured app CPU is under 6%, so a ±1 pp band is ±21% or more even at 1000 RPS. **CPU is therefore a weak test in this campaign at every rung**, not only at the low rungs. That is stated here so no result is read as CPU validation.
- **Floor:** a rung **passes** when its composite is **≥ 95%**. OCI `oci-fit-v1` is reported as verified only if **every rung of both reps passes**. A partial pass is reported per rung and is not a verification.
- **Secondary P95 bands** on `|predicted − measured| / measured`: **pass** ≤ 20%, **marginal** > 20% and ≤ 35%, **fail** > 35%. Reported for every rung; rungs with > 1% steady loss are flagged `saturated`.
- Extras (P99, DB CPU, DB connections, hard errors) are reported as predicted vs measured with the same `rel`; they are not in the composite.
- No fitting. No coefficient, weight, tolerance, or prediction changes after the first apply.

### In-sample scores (fit data, not a result)

`python3 typical/oci-holdout-v2/freeze/insample_check.py` scores the frozen predictions against oci-holdout-v1 r1/r2, without cost (`freeze/insample-scores.json`):

| Rep | RPS | v1 rule | v2 rule (CPU ±1 pp) | \|ΔCPU\| pp | P95 error % |
| --- | --- | --- | --- | --- | --- |
| r1 | 10 | 90.65 | 98.71 | 0.306 | 4.07 |
| r1 | 100 | 90.35 | 98.19 | 0.369 | 5.08 |
| r1 | 500 | 95.90 | 98.73 | 0.481 | 4.52 |
| r1 | 1000 | 98.23 | 98.29 | 0.014 | 5.68 |
| r2 | 10 | 76.57 | 98.80 | 0.305 | 3.76 |
| r2 | 100 | 93.43 | 98.03 | 0.369 | 5.65 |
| r2 | 500 | 96.36 | 98.61 | 0.482 | 4.97 |
| r2 | 1000 | 98.03 | 98.10 | 0.015 | 6.40 |

Leave-one-out on the same data (one rep's values used to predict the other) scores 75.4–96.5 under the v1 rule and **96.1–97.6** under the v2 rule.

### Expected outcome (stated before any apply)

- **Under the v2 rule, all eight rungs are expected to pass** if the stack behaves on the new days as it did on 2026-11-22/23 ET. In-sample margins are 3.0–3.8 points above the floor, and leave-one-out margins are 1.1–2.6 points.
- **Under the v1 rule, 10 and 100 RPS are expected to fail** on app-CPU noise alone, even with a perfect fit. That is why the tolerance exists. The v1-rule composites are reported anyway.
- **What would fail the v2 rule:**
  - any steady loss above 0.01 pp: at 0.05% loss the error score is 20, which costs about 8.9 points;
  - a day-to-day P95 or P50 shift beyond about 15–17% with everything else exact;
  - app CPU leaving the ±1 pp band (for example, above 5.8% at 1000 RPS).
- **If billed cost becomes available,** the composite includes cost. The modeled $0.19–0.23/hr against about $0.25/hr billed would score about 76–92 on cost, which lowers composites by about 0.6–2.3 points. Rungs near 96–97 could then fall below 95. Cost is not adjusted for this.
- **A pass verifies only this topology at 10–1000 RPS in us-ashburn-1**, for P50, P95, throughput and loss. CPU is verified only within ±1 pp. P99, DB CPU, DB connections and cost are reported, not verified.

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

oci-holdout-v1 ran on `17376407cd8107732f35ba45785a9a06e10849a3` (PR #71 merge, adapter 1.9.6). That commit rejects `oci-holdout-v2-…` apply ids in the adapter and in `terraform/oci/variables.tf` (`TEST_ID_MISMATCH`, dry-run in the PR description). The scenario keys, ladder (10 → 100 → 500 → 1000, enforced), 300 s / 900 s timings and region are accepted unchanged.

This pull request's merge commit (adapter **1.9.7**) is the measurement pin. Relative to `17376407` it changes only:

- `OCI_HOLDOUT_TEST_ID_RE` and its error text in `scripts/lib/adapter/oci-catalog.mjs`, which accept `v1` or `v2`;
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

**1. One go covers the whole campaign.** Kevin's single paid-run approval, given after this prereg and its PIN.md follow-up merge, covers r1 and r2, every allowed replacement, and all cleanup. Once that go is given, do not ask again before r2. Run r2 automatically on a different calendar day (America/New_York), at least 12 hours after r1 ends. The Ladder section still requires the two reps to fall on different UTC days; wait until both that requirement and the 12-hour / ET-day rule are satisfied.

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

**8. Faults and replacements.** A pre-rung or runner-side fault means destroying the stack and replacing the whole apply, up to 3 per rep. A 4th pauses and asks. Workload errors and saturation are results, not faults: never retry a rung because of its results.

**9. Spend.** The $25 soft cap pauses and asks; it never auto-stops or destroys mid-rung. The budget alerts are informational only.

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
| r2 scheduling after r1 ends | Run automatically on a different America/New_York calendar day, at least 12 hours later, and on a different UTC day as required by the Ladder section. | No |
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
| $25 soft cap reached | Pause. Do not auto-stop or destroy mid-rung. Budget alerts are informational only. | **Yes** |
| Cleanup after each campaign | Destroy, sweep, sweep again 24 hours later, and check backups. Retry destroy-only cleanup every 2 hours until clean. Delete CWM simulations the runner created. | No, unless a resource still cannot be deleted after 24 hours (**Yes**) |
| Evidence and patches | Archives split into parts under 25 MB, each with sha256. Code changes as patch files. Redact OCIDs, the key, the fingerprint, and account IDs to the last 6 characters. Never contact GitHub. | No |
| Situation not covered here | Follow this preregistration first, then the gcp-holdout-v2 precedent. Record the deviation and the reasoning, and continue. | No, unless it is one of the stop-and-ask items |
| Change to the topology, ladder, timing, or scoring | Do not make the change. | **Yes** |
| Deleting resources the run did not create | Do not delete them. | **Yes** |

