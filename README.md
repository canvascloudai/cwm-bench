# cwm-bench

Versioned, reproducible **measurement program** for [Cloud World Model](https://www.cloudworldmodel.ai), a Canvas Cloud AI product by Kevin Brown (GitHub [canvascloudai](https://github.com/canvascloudai), kevin@canvascloud.ai).

The public accuracy page (`GET https://www.cloudworldmodel.ai/api/accuracy-benchmark`) **consumes this dataset. It does not get to vote on it.**

**v1 owned campaign exists** (`473f1339-f712-4096-96d6-3d4fc07cb427`, filled in `holdout/REPORT.md`). Burst on this CRUD workload measured **≈ 0% errors**. Coefficients are **fitted per-metric** by OLS on idle / normal / peak only (`calibrate/coefficients.yaml`). Holdouts report `fit_prediction` and `delta`. Do not retune coefficients to raise the public score. Do not copy the public 2% / 9.55% cell as owned data. `results/` still has no `isExample: false` run JSON (CI rejects that path).

Public source of this program: [github.com/canvascloudai/cwm-bench](https://github.com/canvascloudai/cwm-bench). Origin namespace: `cloudworldmodel` (name the repo `cwm-bench`).

## Why this exists

CWM's public accuracy benchmark uses canonical topology:

**ALB → 2 × m5.large → db.r5.large MySQL 8.0 Single-AZ, us-east-1**

Live as of **2026-08-29**: `overallScore` **94.7%**. The hole is Burst at **1000 RPS**:

| | Reference (cited) | Simulated |
| --- | ---: | ---: |
| Error rate | 2.00% | 9.55% (0% accuracy on that cell) |
| Throughput | 980 RPS | 905 RPS |

The 2% is cited as RDS connection timeout (~500 max connections) from **AWS documentation**, not a company-owned CloudWatch run. Coefficients on that page are least-squares-fit to documented scenarios. That public 9.55% cell is **not** owned data.

This repo now holds an owned v1 campaign. On this CRUD workload, Burst-class canonical / pool-bound / app-bound runs measured ≈ **0% errors**. That does **not** match the public 2% literature cell. Do not add a CPU-error term for CRUD Burst. cpu-only shows CPU can fail when forced. Coefficients are a per-metric OLS fit of idle / normal / peak. Do **not** retune anything to raise 94.7%.

The owned campaign's primary region was **us-east-2** (not the us-east-1 pin below). Second-region holdout was **us-west-2**.

This repository is the program that produced that dataset: terraform for the topology, a tiny reference app, k6 rungs and diagnostics, schemas the accuracy page must ingest, a per-metric OLS fitter that refuses a composite score, and a filled holdout report.

## Honesty rules

Also in `CONTRIBUTING.md` and in comments on CI.

1. Never optimize the composite accuracy score.
2. Fit per-metric only (CPU, P50/P95/P99, goodput, error-by-class, connections) on a declared fit split.
3. Hold out Burst, plus a later day and a second region.
4. Coefficients ship with measurement SHA, fit split, holdout deltas. A coefficients change without a new measurement ID is rejected.
5. v1 owned campaign is present in `holdout/REPORT.md`. Coefficients are fitted per-metric from owned idle / normal / peak. Do not invent CloudWatch. Do not copy the public 2% / 9.55% Burst cell as owned data. Cost from the public price list can be measured.
6. gp2 `BurstBalance` hitting 0 is a **third** error bucket (`iops_throttle`), distinct from CPU failures and DB connection failures. Do not fold IOPS throttle into either.

## Canonical topology

| Tier | Pin |
| --- | --- |
| Region | `us-east-1` (a second region is holdout) |
| Edge | Application Load Balancer |
| App | **2 × m5.large**, Amazon Linux 2023, Node 20, gp2 root **30 GiB** |
| Database | **1 × db.r5.large**, MySQL 8.0, Single-AZ, gp2 **100 GiB** |
| Generator | **c6i.xlarge** (4 vCPU compute-optimized) running pinned **k6 v0.54.0** |

AMI is resolved from the public SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64` unless you set `ami_id`. **That parameter drifts.** Record `resolved_ami_id` at apply time. See `terraform/README.md`.

`APP_POOL_SIZE` defaults to **250** so two nodes can present **500** sessions toward the parameter-group `max_connections` override (also default **500**). That pairing is a declared topology choice so the pool-bound diagnostic can saturate the *cited* cap. It is not a CloudWatch observation. The RDS MySQL formula `DBInstanceClassMemory/12582880` is higher on db.r5.large (~1365). We override to 500. Details in `terraform/README.md`.

gp2 burst is 3000 IOPS; baseline is `GiB × 3`. When `BurstBalance` hits 0, count **iops_throttle**. The app never emits that class.

## Four RPS rungs

| Name | Target RPS | Script |
| --- | ---: | --- |
| Idle | 10 | `load/scenarios.js` `SCENARIO=idle` |
| Normal | 100 | `SCENARIO=normal` |
| Peak | 500 | `SCENARIO=peak` |
| Burst | 1000 | `SCENARIO=burst` |

Protocol: **warmup, then 15 min steady**. Defaults: `WARMUP=5m`, `DURATION=15m`. Mix: **70% GET product, 20% list, 10% write**.

Burst is **holdout**. Do not put it in the fit set.

## Three diagnostic runs (1000 RPS)

`load/diagnostics.js` — same protocol, 1000 RPS. These **classify** saturation. They do not assert a root cause of the public 9.55% vs 2% cell.

| `DIAGNOSTIC` | App config | Path |
| --- | --- | --- |
| `pool-bound` | expects `APP_POOL_SIZE=250` (default apply) | CRUD mix |
| `app-bound` | expects `APP_POOL_SIZE=40` (re-apply first) | CRUD mix |
| `cpu-only` | pool n/a | `GET /api/cpu-spin` only |

If generator CPU exceeds ~70% in the steady window, discard the run.

## Repository layout

```
app/          Node 20 reference CRUD + seed SQL (8 categories, 200 products, 0 orders)
load/         k6 scenarios + diagnostics + later-day / second-region holdout keys
terraform/    Canonical topology (AWS provider 5.x). fmt/validate in CI; no apply.
schema/       draft 2020-12. EXAMPLE fixtures only (isExample: true).
results/      README + .gitkeep. No runs.
calibrate/    Per-metric OLS (idle/normal/peak). Holdout deltas reported. Refuses composite scores.
holdout/      REPORT.md filled from owned campaign 473f1339…; later-day / second-region predictions from the fit.
scripts/      ci.sh + worker-adapter.mjs (Admin Benchmarks worker contract)
```

## Worker adapter

The Admin Benchmarks worker capability-checks a pinned revision, then
calls this contract. Unknown commands and unknown scenarios fail.

```bash
node scripts/worker-adapter.mjs wait-ready --json
node scripts/worker-adapter.mjs run --scenario <scenario-key> --json
node scripts/worker-adapter.mjs collect --scenario <scenario-key> --json
```

`wait-ready` returns `adapterVersion` (`1.1.0`) and the full
`supportedScenarios` list (`idle`, `normal`, `peak`, `burst`,
`pool-bound`, `app-bound`, `cpu-only`, `later-day`, `second-region`).
`later-day` is a real later-UTC-day holdout, not an alias of `normal`.
`second-region` is a real **us-west-2** holdout, not a rename of the
us-east-1 run. Burst is **not** a capability skip. `collect` must
return a complete run (required CloudWatch datapoints, including ALB,
plus k6 `summary.json` with latency percentiles and error-class
counts) or it fails with `COLLECT_INCOMPLETE`. Empty CloudWatch stays
null. Nothing is invented. See `scripts/README.md`.

The Admin Benchmarks v1 campaign is collected (see `holdout/REPORT.md`).
Burst-class CRUD error on that workload is ≈ 0%. Coefficients are a
per-metric OLS fit of idle / normal / peak. The adapter still requires
a complete collect for burst; it will not write fake CloudWatch into
`results/`.

App check used by the worker and CI:

```bash
cd app && npm ci --ignore-scripts && npm run check
```

## Apply terraform

You need an AWS account you control. This repo ships **no account IDs and no credentials**.

```bash
cd terraform
terraform init
terraform fmt
terraform validate
terraform plan -var='test_id=YYYYMMDD-your-campaign' -out=tfplan
terraform apply tfplan
terraform output
```

Set `ami_id` and `app_source_git_ref` to **this commit SHA** for a campaign you intend to keep. App and generator user_data check out that exact URL and SHA. They do not fall back to `main`, `master`, `HEAD`, or another repository. Copy `alb_dns`, `generator_ip`, `dashboard_url`, `resolved_ami_id` into the campaign record.

Destroy when finished: `terraform destroy -var='test_id=YYYYMMDD-your-campaign'`. RDS delete waits up to 60 minutes. If subnet-group / ENI / SG destroy races RDS deletion, use `scripts/terraform-destroy-retry.sh` (cleanup only; not a campaign result). An interrupted apply should default to cleanup, not resume measurement — the worker owns that policy.

The worker must isolate campaign working directories **by claim**. This repository does not fix the lost-checkout race of a shared campaign directory disappearing mid-apply.

Full notes: `terraform/README.md`.

## Run k6

On the generator (SSM Session Manager; scripts live at `/opt/cwm-bench/load`):

```bash
source /opt/cwm-bench/TARGET.env
export CAMPAIGN_ID=YYYYMMDD-your-campaign
export RUN_ID=idle-1
export SPLIT=fit
export RESULTS_DIR=results/raw/$CAMPAIGN_ID/$RUN_ID
mkdir -p "$RESULTS_DIR"
SCENARIO=idle k6 run --out json="$RESULTS_DIR/k6.json" load/scenarios.js
```

Repeat for `normal`, `peak`, `burst` (`SPLIT=holdout` on Burst). Then the three diagnostics. Copy `results/raw/...` off the instance. Never overwrite.

Full invocation: `load/README.md`.

## Where raw results go

```
results/raw/{campaign_id}/{run_id}/
```

One campaign per directory. Never overwrite. After CloudWatch is pulled, write a schema-valid `run.json` (`schema/run.schema.json`). CI rejects any file under `results/` that claims `isExample: false` until you actually have one — and you must not invent it.

The only JSON run document in this repository today is `schema/example-run.json`. It is marked **EXAMPLE**. It does not look like a campaign and it does not use the live CWM Burst numbers.

## How calibration is supposed to work (once data exists)

1. Collect schema-valid runs. `split=fit` excludes Burst, a later day, and a second region.
2. Fit **each metric independently** (OLS on the intended loss in `calibrate/README.md`).
3. Write `calibrate/coefficients.yaml` with `measurement_sha`, `fit_split`, `holdout_deltas`, `created_at`.
4. Fill `holdout/REPORT.md`. A coefficients PR without those deltas, or with Burst in the fit set, is rejected.
5. The accuracy page reads this dataset. It does not average it with documentation citations to hide Burst.

v1 holdout measurements are recorded. `coefficients.yaml` is a per-metric OLS fit of idle / normal / peak (`metrics.*` non-null; holdout `fit_prediction` / `delta` present). `python3 calibrate/calibrate.py` recomputes that fit from `calibrate/fit_input.yaml` and checks the committed file. `--composite-score` exits non-zero.

## Status of v1

| Artifact | State |
| --- | --- |
| Topology as code | Present |
| Reference app + seed | Present |
| k6 rungs + diagnostics | Present |
| Run / campaign schemas | Present (EXAMPLE fixture only) |
| Raw results | None under `results/` (CI still rejects `isExample: false`) |
| Coefficients | Per-metric OLS on idle / normal / peak; `metrics.*` fitted |
| Holdout tables | Filled from owned campaign `473f1339-f712-4096-96d6-3d4fc07cb427`; predictions + deltas |
| Burst | Owned CRUD Burst-class error ≈ **0%** on this workload (not the public 2% / 9.55% cell) |

## CI

GitHub Actions (`.github/workflows/ci.yml`) and `bash scripts/ci.sh`:

- terraform fmt + validate (**no apply**)
- schema-validate EXAMPLE fixtures
- `k6 inspect` on load scripts
- calibrate provenance (fitted metrics + holdout deltas; Burst not in fit_split)
- holdout v1 tests (REPORT filled, metrics fitted, no owned 9.55)
- calibrate OLS reproducibility + refuse composite score
- reject `results/` files that claim `isExample: false`
- worker-adapter unit tests (AWS mocked; no fabricated campaign)

## Local checks

```bash
python3 -m pip install -r calibrate/requirements.txt
# terraform >= 1.5, k6 0.54.x, Node 20 for app --check
bash scripts/ci.sh
```
