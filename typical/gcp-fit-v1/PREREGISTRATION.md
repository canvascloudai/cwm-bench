# gcp-fit-v1

This directory is **fit / calibration** data for a GCP topology. It is not a holdout. Do not score it as a holdout, and do not mix it into an AWS fit.

Authority for the runner is this file and section 16 of `typical/RUNBOOK-CANVASCLOUDAI.md`.

## Topology

| Piece | Value |
| --- | --- |
| Module | `terraform/gcp` |
| Region | `us-central1` (generator zone `us-central1-a`) |
| Load balancer | External HTTP(S) load balancer, HTTP:80 |
| App | 2 × `n2-standard-2` regional managed instance group, pinned image |
| App workload | `app_profile=typical`, `app_workers=2`, pool 250, same systemd unit and seed as the AWS typical app |
| Database | Cloud SQL MySQL 8.0 `db-custom-2-16384` (requested stand-in for db.r5.large) |
| Flags | `max_connections=500`. `max_prepared_stmt_count` stays at the engine default 16382 unless a later campaign sets it |
| Generator | `c2-standard-4` in-region |

Project id, region, and credentials are variables. This repo does not commit them.

## Ladder

One fresh apply per repetition. Two reps (`r1`, `r2`). On each apply the ladder is **200, then 400, then 600**. Each rung is **300 s warmup + 900 s steady**. Do not change the order, the rates, or the durations.

Scenario keys: `gcp-fit-200`, `gcp-fit-400`, `gcp-fit-600`. They are not `typical-fit-*` keys.

Apply id: `gcp-fit-v1-r{1|2}[a|b|c]-YYYYMMDD`. A replacement uses the next letter, and only one letter. `r1`, `r1a`, `r1b`, and `r1c` are the original plus three replacements.

## Replacement

A **runner fault** (terraform apply error, gcloud/ssh failure, lost generator, collect that cannot read samples) replaces the **whole apply**. Do not re-run a single rung on that stack. At most **3** replacement applies for a rep. A fourth fault pauses and asks. Workload errors, saturation, and slow rungs are results. They do not authorize a replacement.

Nothing here auto-stops the campaign.

## Spend

Soft cap **$60** of billed cost from the BigQuery billing export. At the cap, **pause and ask**. Do not destroy-and-continue, and do not mark the campaign failed on your own. `spendCapDecision` in `scripts/lib/adapter/gcp.mjs` returns `autoStop: false`.

## Cleanup

Destroy with the same variables you applied. Then run `scripts/gcp-cleanup-sweep.sh` immediately, and again **24 hours** later. The sweep lists leftovers. It does not delete by hand, and it is not a campaign result. Resource addresses are the `gcp` entry in `scripts/cleanup-compat.json`. The AWS cleanup pin is unchanged.

## What a collect document is

`collect` prints one object that validates against `schema/run.schema.json`. `split` is `fit`. Latency p50/p95/p99 are steady-only nearest-rank values from raw k6 samples (`steady_p95.py`). Error classes and throughput come from those samples. VM and Cloud SQL CPU, and Cloud SQL connections, come from Cloud Monitoring. Cost comes from the billing export when `CWM_GCP_BILLING_EXPORT_TABLE` is set; otherwise `cost.source` is `unmeasured` and `hourlyUsd` is null. Missing numbers stay null. Nothing is copied from an AWS run.
