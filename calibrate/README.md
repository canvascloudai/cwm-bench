# Calibration

Stub only. **v1 measurements do not exist.** This directory must not grow fitted numbers until a campaign with a `measurement_sha` lands.

## Intended loss

Per-metric ordinary least squares on `split=fit` only:

```
for M in cpu, p50, p95, p99, goodput, error_by_class, connections:
    minimize  Σ_{run in fit} (model(M, run) − measured(M, run))²
```

There is no composite loss. There is no step that raises `overallScore`.

Hold out:

- Burst (1000 RPS), including the three diagnostics
- a later day
- a second region

Those appear in `holdout_deltas` after a fit, never in the fit set.

## What the stub does

```bash
python3 calibrate/calibrate.py
# -> no measurements yet   (exit 0)

python3 calibrate/calibrate.py --check-provenance
# -> exit 0 while coefficients.yaml is all null

python3 calibrate/calibrate.py --composite-score
# -> exit 2, refuses
```

If you pass run JSON files, `isExample: true` documents are ignored. Real runs would be schema-validated and then… still print `no measurements yet` until someone implements the per-metric fit against owned data. Implementing that fit is a later change and still must refuse a composite score.

## Provenance

`coefficients.yaml` and `coefficients.schema.yaml` require:

| Field | Now | Later |
| --- | --- | --- |
| `measurement_sha` | `null` | SHA of the campaign |
| `fit_split` | `null` | run ids (no Burst) |
| `holdout_deltas` | `null` | per-metric holdout deltas |
| `created_at` | `null` | timestamp |
| `metrics.*` | `null` | per-metric coefficients |

A coefficients change without a new `measurement_sha` is rejected by `--check-provenance` and by CI.

## Accuracy page

The accuracy page **consumes** this dataset. It does not vote on coefficients. Until v1 exists, Burst stays a known gap. Do not retune anything to raise 94.7%.
