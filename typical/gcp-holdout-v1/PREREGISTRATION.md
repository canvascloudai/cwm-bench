# gcp-holdout-v1

This directory is a **holdout** for the GCP topology calibrated by `gcp-fit-v1`. It is scored against predictions frozen **before any apply**. Do not use it to refit, do not pool it with `gcp-fit-v1`, and do not mix it with any AWS fit or holdout.

Authority for the runner is this file and the GCP section of `typical/RUNBOOK-CANVASCLOUDAI.md`, run from the pinned merged commit given at run time. A branch name is not a pin.

## Topology

Identical to `gcp-fit-v1`.

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

Scenario keys: `gcp-holdout-300`, `gcp-holdout-400`, `gcp-holdout-500`. They are not `gcp-fit-*` keys.

Apply id: `gcp-holdout-v1-r{1|2}[a|b|c]-YYYYMMDD`.

### Zone placement (as built at pin bd3c1906)

`terraform/gcp` uses `var.zone` **only for the generator** (`generator.tf`). The app tier is a `google_compute_region_instance_group_manager` with no `distribution_policy`, so GCP places the two app instances in zones of its choosing across `us-central1`; `var.zone` does **not** control app placement. In `gcp-fit-v1` both reps placed the app instances in `us-central1-b` and `us-central1-f`, while the generator ran in `-c` (r1) and `-a` (r2). This holdout keeps the module unchanged so the topology matches the fit.

Each rep records, in privacy-safe form (zone names only, no project, instance ids, or full self-links): the generator zone, and the actual zone of each app instance read from the pre-destroy instance inventory. Zone is reported as a covariate; it is not scored.

### Rung labels

| Rung | Label | Meaning |
| --- | --- | --- |
| 300 | **interpolation** | Unseen load between the fitted 200 and 400 rungs |
| 400 | **replication** | Fresh-run replication at a fitted load, not an unseen-load test |
| 500 | **extrapolation** | Unseen load beyond the clean fit range, toward saturation |

Every verdict below is reported separately under these three labels. They are never combined into one score.

## Frozen predictions

Before the first apply, predictions are frozen from the calibrated Cloud World Model engine and committed here with:

- engine version string and build hash as reported by the live API,
- timestamp (UTC) of the query,
- per rung: predicted steady P95 (ms), predicted P50 (ms), predicted app CPU %, DB CPU %, DB connections avg, and the saturation verdict (errors > 1%: yes/no),
- the predicted breakpoint RPS for this topology.

No apply may start until this table is merged. Predictions are not edited after the first apply. An engine change after freezing does not change this table.

| Rung | P95 ms | P50 ms | App CPU % | DB CPU % | DB conns avg | Saturated (>1% errors) |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 77.525 | 11.70 | 27.45 | 44.05 | 76 | No |
| 400 | 98.700 | 12.25 | 35.20 | 57.60 | 111 | No |
| 500 | 119.875 | 12.80 | 42.95 | 71.15 | 270.5 | Yes (assumed) |

Predicted breakpoint: **500** RPS (assumed midpoint of the measured `(400, 600]` bracket; model output, not measured).

**Label:** fit-only, pending holdout. No accuracy-page publication. Nothing deployed; this freeze pins a local engine build identity, not a live rollout.

**Engine identity (local build, not deployed):**
- Query UTC: `2026-11-06T03:00:45.253Z` (2026-11-05 10:00:45 PM ET)
- Evaluator fingerprint: `sha256:e6eb5498b9d872a4d4dc412219bf5f61b20327885bf1226ff1d1ebbac8838493`
- Receipt executable SHA-256: `fc750434cbddeae7b0e2af13ca8d62e611047f2a9b176c074efc9a5f41e7600e`
- Engine version string: not reported as a semver by the local receipt; pin the two hashes above.
- Measurement pin: cwm-bench `bd3c1906731f6ab244a9760cdd4b50f1ccf02f52` (PR #56 merge), adapter **1.7.2**.

**Estimator method (frozen):** assumed 500 RPS midpoint within the measured `(400, 600]` bracket from `gcp-fit-v1` (clean at 400 RPS, saturated at 600 RPS in both fit reps). At 500 RPS, CPU and latency values are **diagnostic extrapolations** from the 200–400 fit secants, not measured. Saturation at 500 is the model's assumed yes for the midpoint estimator. A later engine change does not rewrite this table.

## Verdicts

Each rep and rung is scored separately. **Per-rep results are primary.** A cross-rep mean for a rung is computed only when **both** reps are latency-scored at that rung; otherwise only the per-rep values are reported for that rung. Results are grouped by rung label (interpolation / replication / extrapolation).

### Latency

- Metric: absolute steady-only P95, nearest-rank from raw k6 samples (`steady_p95.py`), over the 900 s steady window.
- Scored **only** on rungs whose measured error rate is **≤ 1%**. Rungs above 1% are reported as `latency: unscored (saturated)`.
- Bands, on |predicted − measured| / measured:
  - **pass** ≤ 20%
  - **marginal** > 20% and ≤ 35%
  - **fail** > 35%
- These are preregistered engineering tolerances, not statistical confidence bounds. The 20% pass threshold is approximately six times the largest rep-to-rep P95 spread observed on the two clean fit rungs (3.1% at 200 RPS, 1.8% at 400 RPS); two repetitions do not establish the full run-to-run variability. The 600 RPS fit rung (19% spread, 14–45% errors) is not used to set bands.

### Saturation

- Binary per rung: **saturated** if the steady error rate is **> 1%**.
- Score: predicted vs measured verdict per rung (hit / miss).
- The fit measurements only **bracket** the breakpoint between 400 RPS (clean) and 600 RPS (saturated in both reps). They do not identify an exact value. The frozen prediction must include the **estimator method**: the model, and explicit assumptions such as how DB connections scale toward `max_connections=500`. A point estimate is a model output, never described as measured.
- Measured breakpoint, per rep:
  - Monotonic ladder: the bracket between the highest rung ≤ 1% and the lowest rung > 1% (for example "between 400 and 500").
  - No rung saturates: "> 500".
  - 300 already saturates (and the ladder is monotonic): "≤ 300".
  - Non-monotonic ladder (for example 400 saturated but 500 not): report **non-monotonic**, score each rung's binary verdict individually, and mark the breakpoint **undetermined**.
- Breakpoint score: **hit** if the frozen predicted breakpoint falls in the measured bracket; **not scored** if undetermined.
- Also report DB connections avg and max against `max_connections=500` as supporting evidence.

### Cost

- Scored **only** when the BigQuery billing export has rows covering the run windows (`cost.source` is not `unmeasured`).
- Otherwise every rung is reported as `cost: unscored (billing export unavailable)`. Missing cost is null, never zero.

### What is not scored

App per-node RPS, generator CPU, and P99 are reported but not scored.

## Replacement

A **runner fault** (terraform apply error, gcloud/ssh failure, lost generator, collect that cannot read samples) replaces the **whole apply**. Do not re-run a single rung on that stack. Do not pool rungs across applies. At most **3** replacement applies per rep. A fourth fault pauses and asks.

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

Soft cap **$60** of billed cost from the billing export. At the cap, **pause and ask**. Do not destroy-and-continue, and do not mark the campaign failed on your own. Nothing here auto-stops the campaign.

## Cleanup

Destroy with the same variables you applied. Then run `scripts/gcp-cleanup-sweep.sh` immediately, and again **24 hours** later. Cleanup is **destroy-only**: retry `terraform destroy` on a two-hour schedule; never force-delete networks, peerings, or other resources by hand. Google-held remnants are documented, not removed.

## Code changes

Any change to measurement code, the adapter, Terraform, or the scorer after this file is merged requires a **new version** (`gcp-holdout-v1.1`, with a new pin) and fresh frozen predictions. Results from different pins or versions are never pooled. Runner-side launcher or controller fixes outside cwm-bench are allowed only if they do not touch measurement, and their hash is recorded in the archive.

## Amendment 2026-11-05

Before any apply, the measurement pin moves from `bd3c1906731f6ab244a9760cdd4b50f1ccf02f52` (adapter 1.7.2) to this pull request's merge commit (adapter **1.7.3**). This change is wiring only: it registers `gcp-holdout-300`, `gcp-holdout-400`, and `gcp-holdout-500`, holdout ID validation, collect labeling, and the matching scenario-to-RPS map entries. The request mix, 300 s warmup, 900 s steady, topology, Terraform, scorer, and `gcp-fit-v1` behavior are unchanged. The frozen predictions, estimator method, and engine hashes above are unchanged.

Source patch SHA-256: `26e456dcb7b1634916550e9573caa9d95b78574106dec38392627e37db99d1c8`.

## Privacy

Archives and this directory contain no project id, project number, service-account email, billing account id, or instance identifiers beyond redacted forms.
