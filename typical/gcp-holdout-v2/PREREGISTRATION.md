# gcp-holdout-v2

This directory is a **holdout** for the GCP topology calibrated by `gcp-fit-v1` after the r2 refit. It is scored against predictions frozen **before any apply**. Do not use it to refit, do not pool it with `gcp-fit-v1`, and do not pool it with `gcp-holdout-v1`. Do not mix it with any AWS fit or holdout.

**`gcp-holdout-v1` rep r2 is now fit data.** The refit trained on the original `gcp-fit-v1` clean measurements plus healthy `gcp-holdout-v1` r2 only. `gcp-holdout-v1` r1 (degraded one-node MIG) and the original saturated 600-RPS rung are excluded from every regression. Because r2's 300/400/500 observations entered the training inventory, they are no longer independent holdout observations.

Authority for the runner is this file and the GCP section of `typical/RUNBOOK-CANVASCLOUDAI.md`, run from the pinned merged commit given at run time. A branch name is not a pin.

## Topology

Identical to `gcp-fit-v1` and `gcp-holdout-v1`.

| Piece | Value |
| --- | --- |
| Module | `terraform/gcp` |
| Region | `us-central1`. `var.zone` is chosen by the stockout rule below and **recorded per rep** |
| Load balancer | External HTTP(S) load balancer, HTTP:80 |
| App | 2 × `n2-standard-2` regional managed instance group, pinned image |
| App workload | `app_profile=typical`, `app_workers=2`, pool 250, same systemd unit and seed as `gcp-fit-v1` |
| Database | Cloud SQL MySQL 8.0 `db-custom-2-13312` (2 vCPU, 13 GiB), PD_SSD 100 GiB |
| Flags | `max_connections=500`, `max_prepared_stmt_count` engine default |
| Generator | `c2-standard-4` in-region |

Project id, credentials, and billing account are variables. This repo does not commit them.

## Ladder

One fresh apply per repetition. Two reps (`r1`, `r2`). On each apply the ladder is **300, then 400, then 500**. Each rung is **300 s warmup + 900 s steady**. Do not change the order, the rates, or the durations.

Scenario keys: `gcp-holdout-300`, `gcp-holdout-400`, `gcp-holdout-500`. These are the same keys as `gcp-holdout-v1` (same mix, timings, and ladder). They are not `gcp-fit-*` keys and they are not `gcp-holdout-v2-*` keys. Campaign identity is the test id, not the scenario key.

Apply id: `gcp-holdout-v2-r{1|2}[a|b|c]-YYYYMMDD`.

The adapter accepts only the zone suffixes **a**, **b**, and **c** (or no suffix). If `var.zone` is `us-central1-f`, use the unsuffixed id. Do not use a `d` or `f` suffix.

The pre-load GCP backend-health gate from adapter **1.7.4** is **required**. k6 must not start until every MIG backend in the external HTTP load balancer backend service is `HEALTHY` for 60 consecutive seconds. A timeout is a replaceable pre-rung runner fault (`GCP_BACKEND_HEALTH_TIMEOUT`). This would have refused `gcp-holdout-v1` rep r1, which served like a one-node MIG.

### Zone placement (as built at pin bd3c1906)

`terraform/gcp` uses `var.zone` **only for the generator** (`generator.tf`). The app tier is a `google_compute_region_instance_group_manager` with no `distribution_policy`, so GCP places the two app instances in zones of its choosing across `us-central1`; `var.zone` does **not** control app placement. In `gcp-fit-v1` both reps placed the app instances in `us-central1-b` and `us-central1-f`, while the generator ran in `-c` (r1) and `-a` (r2). This holdout keeps the module unchanged so the topology matches the fit.

Each rep records, in privacy-safe form (zone names only, no project, instance ids, or full self-links): the generator zone, and the actual zone of each app instance read from the pre-destroy instance inventory. Zone is reported as a covariate; it is not scored.

### Rung labels

The refit trained on original `gcp-fit-v1` rows at 200 and 400 RPS plus healthy `gcp-holdout-v1` r2 at 300, 400, and 500 RPS. Every load on this ladder is therefore a **fitted** load. This campaign is an independent **replication** holdout on fresh applies. It does not test unseen interpolation or extrapolation loads.

| Rung | Label | Meaning |
| --- | --- | --- |
| 300 | **replication** | Fresh-apply replication at a fitted load (r2 300 is now training data) |
| 400 | **replication** | Fresh-apply replication at a fitted load (original 400 and r2 400 are training data) |
| 500 | **replication** | Fresh-apply replication at a fitted load (r2 500 is now training data). Also tests the frozen "not saturated at 500" verdict |

Every verdict below is reported separately per rung. They are never combined into one score. The assumed saturation onset at 550 RPS is not itself a load on this ladder; see Saturation.

## Frozen predictions

Before the first apply, predictions are frozen from the recalibrated Cloud World Model engine and committed here with:

- engine version string and evaluator fingerprint as reported by the local receipt,
- timestamp (UTC) of the receipt evaluation,
- per rung: predicted steady P95 (ms), predicted P50 (ms), predicted app CPU % (per node), DB CPU %, DB connections avg, and the saturation verdict (errors > 1%: yes/no),
- the predicted breakpoint RPS for this topology.

No apply may start until this table is merged. Predictions are not edited after the first apply. An engine change after freezing does not change this table.

Display rounding below follows the identified executable's published table; scoring uses these committed values.

| Rung | P95 ms | P50 ms | App CPU % | DB CPU % | DB conns avg | Saturated (>1% errors) |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 68.655389278 | 11.152871833 | 26.727293778 | 42.638881944 | 74.115343944 | No |
| 400 | 86.161019630 | 11.361998556 | 33.626288296 | 54.902027741 | 110.287478074 | No |
| 500 | 103.666649981 | 11.571125278 | 40.525282815 | 67.165173537 | 146.459612204 | No |

Predicted breakpoint: **550** RPS (assumed inclusive midpoint of the measured `(500, 600]` bracket; model output, not measured). Decision rule: `saturated = offeredRps >= 550`.

**Label:** fit-only, pending this holdout. No accuracy-page publication. Nothing deployed; this freeze pins a local engine build identity, not a live rollout. `CWM_ENABLE_GCP_FIT_V1` remains default **OFF**; only the exact string `true` enables it. MCP tool descriptions must not mention the candidate while the flag is off.

**Engine identity (local build, not deployed):**
- Engine version: `1.2.71` (ordinary engine calculations unchanged)
- Calibration identity: `gcp-fit-v1`
- Estimator identity: `gcp-fit-v1/ols-midpoint-v2`
- Receipt evaluation UTC: `2026-11-06T16:01:33.303Z` (2026-11-06 11:01:33 AM ET)
- Build timestamp UTC: `2026-11-06T16:00:57.656Z` (2026-11-06 11:00:57 AM ET)
- Evaluator/source fingerprint: `sha256:74a7876ab75cdb8e1229e9d5a787091e0dfd0096d81ea3014e7a345d4115a434`
- Receipt executable SHA-256: `3485481885eddace7ffca8be21f86e67734d573d4294239e7ff98b06b0f64c2e`
- Source base revision: `c7965ae5ffb0a630ebf0746ca57a301813a071ba` (embedded label `c7965ae5ffb0`). The source base revision alone does **not** contain these uncommitted local changes. The evaluator fingerprint identifies the actual source and data consumed by the executable.
- OFF baseline file SHA-256: `780885231838392b1b7a969bd78d7e03e3b0c74974c5f41b91cfc478ca641c97`
- Canonical OFF before **and** after result SHA-256: `d7516128d7f8ecd7e520c4cc693bd4cf7b4c2f944fbb1dd5828580a065061d34`
- Previous-candidate receipt SHA-256: `ef0a0c73663df575466329fd7b5da233269a612b75d21f340b233762524762ba` (retained for comparison; not this freeze)

**Training inventory (for provenance, not to be re-used as this campaign's results):**
- Original `gcp-fit-v1` measurement pin `bd3c1906`, clean rows at 200 and 400 RPS (both reps). Connection averages 41/111 are shared rung aggregates repeated with two-apply weight, not per-rep connection measurements.
- Healthy `gcp-holdout-v1` r2: scored collect `gcp-holdout-v1-r2a-20261106`, measurement pin `7ff414717b5360276794aee97b13f54408336aa9`, adapter **1.7.3**.
- Excluded: `gcp-holdout-v1` r1 (degraded one-node MIG) and the original saturated 600-RPS rung.

**Estimator method (frozen):** each of five targets has its own OLS affine model against total offered RPS: `y(T)=a+b*T`. Full supplied precision, no premature rounding. Exact binary64 coefficients from the identified executable:

| Target | Intercept a | Slope b per total offered RPS |
| --- | --- | --- |
| Steady P95 ms | 16.138498222222232 | 0.1750563035185185 |
| Steady P50 ms | 10.525491666666666 | 0.002091267222222224 |
| Per-node app CPU % | 6.030310222222219 | 0.0689899451851852 |
| DB CPU % | 5.84944455555555 | 0.12263145796296299 |
| Average DB connections, clean through 500 | -34.40105844444446 | 0.36172134129629635 |

CPU slopes have units **percentage points**, not fractions or aggregate app+DB CPU. Under the even two-node split, the app slope per node RPS is `0.1379798903703704`. These are sparse descriptive regressions, not universal extrapolation laws. 300/400/500 are training rungs of the refit, so the rows above are fitted values, not unseen-load predictions.

Measured saturation bracket remains **>500 and <=600 RPS**, saturation meaning **>1% steady errors**. `midpoint-v2` assumes `(500+600)/2 = 550` RPS, inclusive decision `saturated = offeredRps >= 550`. The point estimate and equality rule are assumptions, **not measured threshold identification**. No error-rate curve, connection-cap intersection, or causal HTTP 500 attribution is inferred.

Connections follow the clean OLS through 500. Above 500 through 600 the receipt uses a continuous assumed bridge/secant `C(T)=C500+s*(T−500)` with `C500=146.45961220370373` and `s=(430−C500)/100=2.8354038779629627` connections per total RPS. That bridge is not used by the 300/400/500 frozen rows. The endpoint 430 is approximate.

A later engine change does not rewrite this table.

## Verdicts

Each rep and rung is scored separately. **Per-rep results are primary.** A cross-rep mean for a rung is computed only when **both** reps are latency-scored at that rung; otherwise only the per-rep values are reported for that rung.

### Latency

- Metric: absolute steady-only P95, nearest-rank from raw k6 samples (`steady_p95.py`), over the 900 s steady window.
- Scored **only** on rungs whose measured error rate is **≤ 1%**. Rungs above 1% are reported as `latency: unscored (saturated)`.
- Bands, on |predicted − measured| / measured:
  - **pass** ≤ 20%
  - **marginal** > 20% and ≤ 35%
  - **fail** > 35%
- These are the same preregistered engineering tolerances as `gcp-holdout-v1`, not statistical confidence bounds, and are not re-derived for this version.

### Saturation

- Binary per rung: **saturated** if the steady error rate is **> 1%**.
- Score: predicted vs measured verdict per rung (hit / miss). Frozen predictions are **not saturated** at 300, 400, and 500.
- The fit measurements only **bracket** the breakpoint between 500 RPS (clean in the training inventory) and 600 RPS (saturated in the original fit). They do not identify an exact value. The frozen prediction of 550 RPS is an assumed midpoint. A point estimate is a model output, never described as measured.
- Measured breakpoint, per rep:
  - Monotonic ladder: the bracket between the highest rung ≤ 1% and the lowest rung > 1% (for example "between 400 and 500").
  - No rung saturates: "> 500".
  - 300 already saturates (and the ladder is monotonic): "≤ 300".
  - Non-monotonic ladder (for example 400 saturated but 500 not): report **non-monotonic**, score each rung's binary verdict individually, and mark the breakpoint **undetermined**.
- Breakpoint score: **hit** if the frozen predicted breakpoint (550) falls in the measured bracket; **not scored** if undetermined. This 300/400/500 ladder cannot distinguish 550 from any other value above 500: if no rung saturates, the measured bracket is "> 500" and 550 is a hit. If 500 saturates and 400 does not, the measured bracket is "(400, 500]" and 550 is a miss.
- Also report DB connections avg and max against `max_connections=500` as supporting evidence.

### Cost

- Scored **only** when the BigQuery billing export has rows covering the run windows (`cost.source` is not `unmeasured`).
- Otherwise every rung is reported as `cost: unscored (billing export unavailable)`. Missing cost is null, never zero.

### What is not scored

App per-node RPS, generator CPU, and P99 are reported but not scored.

## Replacement

A **runner fault** (terraform apply error, gcloud/ssh failure, lost generator, backend-health timeout, collect that cannot read samples) replaces the **whole apply**. Do not re-run a single rung on that stack. Do not pool rungs across applies. At most **3** replacement applies per rep. A fourth fault **pauses and asks**.

Workload errors, saturation, and slow rungs are **results**. They do not authorize a replacement.

### Stockouts and zones

- Zone order for `var.zone` is **us-central1-c, then us-central1-a, then us-central1-f**. A `c2-standard-4` or `n2-standard-2` stockout moves to the next zone with a fresh apply. (An `n2-standard-2` stockout comes from the regional app MIG, which `var.zone` does not steer; the rotation still produces a fresh apply.)
- A partially provisioned attempt is **destroyed and cleanup-verified** (live inventory shows no paid resources from that apply) before the fresh apply.
- If **c, a, and f** are all stocked out, **pause and ask**. Do not try other zones or regions.
- Stockouts happen before any rung and are **excluded** from the two-consecutive-identical-deterministic-error guard. If stockouts alone use the last replacement, pause and ask.
- Two consecutive applies that fail with the **same deterministic error** (not a stockout) stop and report.

### Control connection

IAP / SSH control-connection errors are transient. The controller reconnects with backoff for up to about 10 minutes and **never stops k6**. A rung is lost only if the raw k6 samples cannot be collected; that is a runner fault.

## Spend

Soft cap **$60** of billed cost from the billing export, matching `GCP_FIT_SPEND_CAP_USD` / `spendCapDecision` in the adapter (`autoStop: false`). At the cap, **pause and ask**. Do not destroy-and-continue, and do not mark the campaign failed on your own. Nothing here auto-stops the campaign.

## Cleanup

Destroy with the same variables you applied. Then run `scripts/gcp-cleanup-sweep.sh` immediately, and again **24 hours** later. Cleanup is **destroy-only**: retry `terraform destroy` on a two-hour schedule; never force-delete networks, peerings, or other resources by hand. Google-held remnants are documented, not removed.

## Measurement pin

Current `main` at freeze time is `21a6b3018374f90c0c21189b036574603cf39f2b` (merge of the adapter 1.7.4 backend-health gate). That checkout accepts the scenario keys `gcp-holdout-300/400/500` but **rejects** `gcp-holdout-v2-…` test ids (`TEST_ID_MISMATCH`).

Before any apply, the measurement pin moves from `21a6b3018374f90c0c21189b036574603cf39f2b` (adapter 1.7.4) to **this pull request's merge commit** (adapter **1.7.5**). That version is wiring only: it accepts `gcp-holdout-v2` campaign ids on the existing holdout keys, labels collect notes from the id, and keeps the 1.7.4 backend-health gate. The request mix, 300 s warmup, 900 s steady, topology, Terraform, scorer, health-gate thresholds, and `gcp-fit-v1` / `gcp-holdout-v1` behavior are unchanged. The frozen predictions, estimator method, and engine hashes above are unchanged by the pin move.

## Code changes

Any change to measurement code, the adapter, Terraform, or the scorer after this file is merged requires a **new version** (`gcp-holdout-v2.1`, with a new pin) and fresh frozen predictions. Results from different pins or versions are never pooled. Runner-side launcher or controller fixes outside cwm-bench are allowed only if they do not touch measurement, and their hash is recorded in the archive.

## Privacy

Archives and this directory contain no project id, project number, service-account email, billing account id, or instance identifiers beyond redacted forms.
