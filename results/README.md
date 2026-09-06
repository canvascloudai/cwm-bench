# Results

Raw results land here. The v1 owned campaign is summarized in `holdout/REPORT.md`. This directory is still empty of run JSON on purpose (CI rejects `isExample: false` here).

## Convention

```
results/raw/{campaign_id}/{run_id}/
```

- One campaign per directory under `raw/`.
- Never overwrite a `run_id`. A repeat is a new `run_id`.
- k6 writes `summary.json` (and optional `k6.json` / `k6.csv`) from the generator. Copy them here after the run.
- The schema-valid run document (see `schema/run.schema.json`) lives beside those files as `run.json` once CloudWatch fields are filled.

`.gitkeep` keeps `raw/` in git. Files under `raw/` are gitignored except the keep file.

## Honesty

Do not commit a file that claims `isExample: false`. CI searches `results/` for that claim and fails. The owned v1 campaign is published via `holdout/REPORT.md` and `calibrate/coefficients.yaml` (metrics null). The only JSON run document in this repository is `schema/example-run.json` (`isExample: true`), and it is **not** a result.

Do not invent CloudWatch numbers, coefficients, customers, or revenue. Do not copy the live CWM Burst cell (9.55% / 2.00%) into this tree as if we measured it.
