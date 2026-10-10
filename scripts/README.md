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

`wait-ready` always returns `adapterVersion` (`1.6.1`) and `supportedScenarios`.
`1.6.1` records `measurementSha` on typical-p95-v1 collects only.
`1.6.0` adds `typical-p95-{1x,2x,3x}-{300,200,100}`, the reverse ladder,
and gzipped k6 request-level output for those keys. `1.5.0` adds
`typical-scale-{1x,2x,3x}-{100,200,300}` and
`APP_COUNT_MISMATCH`. Scale-v1 artifacts stay at `1.5.0`. `1.4.0` added `typical-later-day`,
`typical-later-day-300`, `typical-second-region`, and
`typical-second-region-300`; those holdout artifacts stay at `1.4.0`.
The recorded `typical-v1-20260927c` campaign stays at adapter `1.3.0`.
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
| `typical-later-day-300` | Same later-day holdout at 300 total RPS. Same profile, workers, pool, region, and fit-date check. Not a rename of `typical-holdout-300`. |
| `typical-second-region` | Typical holdout at 100 total RPS on `load/typical.js` in **us-west-2** only. Same profile, workers, and pool 250. Other typical keys still reject us-west-2. Not the lean `second-region` key. |
| `typical-second-region-300` | Same second-region holdout at 300 total RPS in **us-west-2** only. `typical-holdout-300` still rejects us-west-2. |
| `typical-scale-{1x,2x,3x}-{100,200,300}` | Typical-scale-v1 validation at 100 / 200 / 300 total RPS on 1, 2, or 3 app servers. Holdout split, pool 250, **us-east-2**. The key's `expectedAppCount` must match `topology.app_count` and `app_instance_ids` length (`APP_COUNT_MISMATCH`). Other typical keys expect 2. Ladder metadata stays 100 → 200 → 300 and is not enforced. |
| `typical-p95-{1x,2x,3x}-{300,200,100}` | Typical-p95-v1 validation. Holdout split, pool 250, **us-east-2**, app count 1, 2, or 3 (`APP_COUNT_MISMATCH`). Ladder 300 → 200 → 100 is enforced per test id. Test id `typical-p95-{1x|2x|3x}-r{1..3}-YYYYMMDD` (letter suffix on a replacement). Not a fit, holdout, or scale key. Scored p95 is the untagged aggregate. |

`run` reads `/api/meta` before k6. A lean key on a typical stack, or a typical key on a lean stack, fails with `PROFILE_MISMATCH` and does not start k6. A typical key other than `typical-second-region` and `typical-second-region-300` outside us-east-2 fails with `TYPICAL_REGION_CONSTRAINT`. Those two keys fail unless the region is us-west-2 (`SECOND_REGION_CONSTRAINT`). `typical-later-day` and `typical-later-day-300` fail with `LATER_DAY_CONSTRAINT` unless the UTC day is after the fit campaign date. A typical key whose live app count is not `expectedAppCount` fails with `APP_COUNT_MISMATCH` (2 for every typical key except the nine `typical-scale-*` keys and the nine `typical-p95-*` keys, which expect 1, 2, or 3). A `typical-p95-*` key whose test id is not `typical-p95-{1x|2x|3x}-r{1..3}-YYYYMMDD` fails with `TEST_ID_MISMATCH`. Running a fit, holdout, or scale key under that test id fails with `REUSED_KEY`. The p95 ladder rejects any order other than 300, then 200, then 100 (`LADDER_ORDER`). `collect` applies the same day, region, and app-count checks. `wait-ready` includes `appNodes`, one object per app server, with `profile`, `workers`, and `gitSha` from `/api/meta`, and lists the typical holdout keys, the nine `typical-scale-*` keys, and the nine `typical-p95-*` keys in `supportedScenarios`. Missing `profile` on the lean app is reported as null there; `run` treats a missing profile as lean so the owned campaign still starts.

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
