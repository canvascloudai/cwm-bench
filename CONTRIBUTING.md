# Contributing to cwm-bench

This repository is the **measurement program** for [Cloud World Model](https://www.cloudworldmodel.ai). The accuracy page consumes this dataset. It does not get to vote on it.

Owned by Canvas Cloud AI (Kevin Brown, GitHub [canvascloudai](https://github.com/canvascloudai), kevin@canvascloud.ai).

## Honesty rules

These rules are also in `README.md` and in comments on `.github/workflows/ci.yml` / `scripts/ci.sh`. They are not optional.

1. **Never optimize the composite accuracy score.** Do not search for coefficients, mix weights, or topology tweaks whose purpose is to raise `overallScore`.
2. **Fit per-metric only** (CPU, P50/P95/P99, goodput, error-by-class, connections) on a **declared fit split**.
3. **Hold out Burst**, plus a later day and a second region.
4. **Coefficients ship with `measurement_sha`, `fit_split`, `holdout_deltas`.** A coefficients change without a new measurement ID is rejected (CI `--check-provenance`).
5. **Until v1 measurements exist:** keep Burst error visible as a known gap **or** leave the floor failing. Do not label latency / CPU / throughput / error as "measured". Cost from the public price list can be measured.
6. **gp2 `BurstBalance` hitting 0 is a third error bucket** (`iops_throttle`), distinct from CPU failures and DB connection failures. Do not fold IOPS throttle into either.

## What you may add

- Schema-valid runs under `results/raw/{campaign_id}/{run_id}/` from an actual apply + k6 + CloudWatch pull. Never overwrite.
- Holdout tables in `holdout/REPORT.md` filled from those runs.
- Coefficients **only** with a new `measurement_sha` and reported holdout deltas. Burst must not be in the fit set.
- Fixes to terraform, the reference app, or k6 scripts that make the program more reproducible. Say so in the commit. Do not sneak in mix or pool changes that exist to move a score.

## What you must not add

- Invented CloudWatch numbers, fitted coefficients, customers, or revenue.
- A `results/` file with `isExample: false` that is not a real run (CI rejects the claim; do not invent the run either).
- EXAMPLE fixtures that look like a finished campaign or that reuse the live CWM Burst figures (9.55% / 2.00% / 980 / 905) as if we measured them.
- Comments that assert a root cause of the public Burst gap. The diagnostics **classify**; they do not close the gap.
- `terraform apply` in CI.

## PR checklist

- [ ] `bash scripts/ci.sh` passes (terraform fmt/validate, schema EXAMPLE, k6 inspect, calibrate stub, results honesty, worker-adapter tests).
- [ ] Burst remains a known gap unless this PR lands a real v1 campaign.
- [ ] No composite-score work.
- [ ] New coefficients ⇒ new `measurement_sha` + holdout deltas + Burst not in fit.

## Campaign procedure (once you have an AWS account)

1. Pin `ami_id` and `app_source_git_ref` (this SHA).
2. `terraform apply` with a `test_id` equal to your `campaign_id`.
3. Record outputs (`resolved_ami_id`, instance ids, volume ids).
4. Run `load/scenarios.js` for idle / normal / peak / burst (warmup 5m, steady 15m).
5. Run `load/diagnostics.js` three times at 1000 RPS (pool-bound, app-bound, cpu-only). Re-apply with `app_pool_size=40` before app-bound.
6. Pull CloudWatch into a schema-valid `run.json`. Include `iops_throttle` from `BurstBalance`.
7. Put Burst, a later day, and a second region in holdout. Fit the rest per-metric only.
8. Open a PR that fills `holdout/REPORT.md`. Do not retune to raise the public score.

Questions: kevin@canvascloud.ai.
