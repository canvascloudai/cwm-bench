# Schemas

JSON Schema **draft 2020-12**.

| File | What |
| --- | --- |
| `run.schema.json` | One run (k6 + CloudWatch + topology provenance). |
| `campaign.schema.json` | A campaign wrapping runs and the fit/holdout split. |
| `example-run.json` | **EXAMPLE** fixture. `isExample: true`. Placeholders only. |
| `example-campaign.json` | **EXAMPLE** wrapper. No runs that look real. |

The accuracy page consumes documents that validate against these schemas. It does not get to vote on the numbers.

## EXAMPLE vs measured

`example-run.json` is the only populated run document in this repository on purpose.

- `isExample` is `true`.
- `campaign_id` is `EXAMPLE_NOT_A_MEASUREMENT`.
- Metric fields are `null` or zero. They are **not** the live CWM Burst figures (do not paste 9.55% / 2.00% / 980 / 905 here).
- CI validates this fixture against the schema.

A file with `isExample: false` under `results/` is treated as a claimed measurement. CI still rejects that path. The owned v1 campaign is published in `holdout/REPORT.md` and `calibrate/` (per-metric OLS from those published values), not as run JSON under `results/`.

## Required provenance

A real run must carry:

- exact instance types and regions
- OS + resolved AMI id
- runtime (Node 20.x as applied)
- application (`APP_POOL_SIZE`)
- database (engine + declared `max_connections`)
- dataset row counts
- request mix and concurrency
- warmup and duration
- per-node CPU and RPS
- P50 / P95 / P99
- error categories by class, including `iops_throttle`
- database connections and saturation
- BurstBalance minima
- cost + timestamp (price list is allowed for cost)
- repetitions and variance notes
- git SHA of this repo
- terraform apply SHA and AMI ids
- `campaign_id`, `run_id`, `split` (`fit` \| `holdout`)
- `diagnostic` (`canonical` \| `pool-bound` \| `app-bound` \| `cpu-only` \| `none`)

## Validate

```bash
python3 scripts/validate_schema.py
```
