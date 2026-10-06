# Scripts

## Worker adapter

The Canvas Cloud AI Admin Benchmarks worker calls this contract after it
capability-checks a pinned revision. Unknown commands and unknown
scenarios fail (nonzero). Success prints one JSON object on stdout.

```bash
node scripts/worker-adapter.mjs wait-ready --json
node scripts/worker-adapter.mjs run --scenario <scenario-key> --json
node scripts/worker-adapter.mjs collect --scenario <scenario-key> --json
node scripts/worker-adapter.mjs --help
```

`wait-ready` always returns `adapterVersion` (`1.4.0`) and `supportedScenarios`.
`1.4.0` adds `typical-later-day` and `typical-second-region`. The recorded
`typical-v1-20260927c` campaign stays at adapter `1.3.0`.
If Terraform state exists, it also verifies app health and SSM
reachability (no inbound SSH). Post-provision checks retry normal
bootstrap delays for up to 20 minutes by default, while terminal AWS/SSM
errors fail immediately. `CWM_READINESS_TIMEOUT_MS` and
`CWM_READINESS_POLL_MS` can override the bounded wait. If state is
absent, it still succeeds so the worker can capability-check before
provisioning.

`run` executes the requested workload on the generator through AWS SSM
and persists `lastRun` (scenario, runId, campaignId) in adapter state
so `collect` can find artifacts without `CWM_RUN_ID`.

`collect` reads Terraform outputs (including `alb_arn` /
`target_group_arn`), the resolved AMI, CloudWatch GetMetricStatistics
(app/generator/RDS CPU, DatabaseConnections, RDS and app-EBS
BurstBalance, plus ALB RequestCount, target/ELB HTTP codes, and
TargetResponseTime p50/p95/p99), and the generator `summary.json`.
It stitches those into run-schema fields: `latency` (prefer k6; ALB
is also recorded), `errorCategories` (k6 tags plus `iops_throttle`
when BurstBalance min is 0), `perNode` CPU, `goodputRps`,
`databaseConnections`, `burstBalanceMin`. Empty CloudWatch datapoints
stay null. Nothing is invented. The public CWM 2% / 9.55% cell is
never copied into results.

If a scenario claims `completeness: collected` (burst) and any required
CloudWatch datapoint or k6 summary field is missing, collect sets
`complete: false` and fails with `COLLECT_INCOMPLETE` (nonzero /
`ok: false`) so the worker cannot ingest an incomplete burst as
measured.

### Scenario keys

| Key | What it is |
| --- | --- |
| `idle` / `normal` / `peak` / `burst` | Canonical rungs (10 / 100 / 500 / 1000 RPS) |
| `pool-bound` / `app-bound` / `cpu-only` | 1000 RPS diagnostics |
| `later-day` | Holdout. Fails unless today (UTC) is after the fit campaign date. Runs `SCENARIO=later-day`, not `normal`. |
| `second-region` | Holdout. Fails unless Terraform region is **us-west-2**. Runs `SCENARIO=second-region`, not the primary-region apply. |
| `typical-fit-20` / `typical-fit-100` / `typical-fit-200` | Typical profile fit rungs at 20 / 100 / 200 total RPS. Require `app_profile=typical`, `app_workers=2`, and region **us-east-2**. |
| `typical-holdout-300` | Typical holdout at 300 total RPS. Same profile, workers, and region constraints. |
| `typical-saturation-500` | Optional typical diagnostic holdout at 500 total RPS. Completeness is optional. |
| `typical-later-day` | Typical holdout at 100 total RPS on `load/typical.js`. Same profile, workers, pool 250, and **us-east-2** lock. Fails unless today (UTC) is after the fit campaign date (`CWM_FIT_CAMPAIGN_DATE` or adapter state). For the fitted reference that date is `2026-09-27` (`typical-v1-20260927c`). Not the lean `later-day` key. |
| `typical-second-region` | Typical holdout at 100 total RPS on `load/typical.js` in **us-west-2** only. Same profile, workers, and pool 250. Other typical keys still reject us-west-2. Not the lean `second-region` key. |

`run` reads `/api/meta` before k6. A lean key on a typical stack, or a typical key on a lean stack, fails with `PROFILE_MISMATCH` and does not start k6. A typical key other than `typical-second-region` outside us-east-2 fails with `TYPICAL_REGION_CONSTRAINT`. `typical-second-region` fails unless the region is us-west-2 (`SECOND_REGION_CONSTRAINT`). `typical-later-day` fails with `LATER_DAY_CONSTRAINT` unless the UTC day is after the fit campaign date. `collect` applies the same day and region checks. `wait-ready` includes `appNodes`, one object per app server, with `profile`, `workers`, and `gitSha` from `/api/meta`, and lists both new keys in `supportedScenarios`. Missing `profile` on the lean app is reported as null there; `run` treats a missing profile as lean so the owned campaign still starts.

Public CWM `GET /api/accuracy-benchmark` lists idle / normal / peak /
burst only. later-day and second-region come from this repo's campaign
schema and honesty rules. No other CWM-internal keys were found in
public docs; none were guessed.

Burst is a **supported** scenario that **requires a complete collect**.
It is not a `knownGaps` capability skip. The remaining operational
step is the Admin Benchmarks burst campaign (1000 RPS, 5m warmup +
15m, then the three 1000 RPS diagnostics). The adapter will not call
burst complete until that collect is complete. It will not write fake
CloudWatch into `results/`.

`app-bound` expects `APP_POOL_SIZE=40` (re-apply first). It will not
run against the default 250-pool topology.

### Cleanup pin

Already-provisioned campaigns are destroyed from

`e95c5319b5c7b9cbd934735241b355df4144cab0`

That revision must stay publicly fetchable. Resource addresses are
listed in `scripts/cleanup-compat.json` and `terraform/CLEANUP-COMPAT.md`.

## Other scripts

| Script | Purpose |
| --- | --- |
| `ci.sh` | Local + Actions entrypoint (honesty, provenance, schema, adapter tests, terraform validate) |
| `validate_schema.py` | EXAMPLE fixtures only |
| `check_results_honesty.py` | Reject `results/` files that claim `isExample: false` |
| `terraform-destroy-retry.sh` | Cleanup-only destroy with bounded retries for RDS ENI / subnet-group / SG eventual consistency. Not a campaign result. |
