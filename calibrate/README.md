# Calibration

Per-metric ordinary least squares on the owned v1 campaign. **Fit split is idle / normal / peak only.** Burst, pool-bound, app-bound, cpu-only, later-day, and second-region are holdout. They appear in `holdout_deltas` with `fit_prediction` and `delta` after the fit. Do not invent CloudWatch. Do not copy the public 2% / 9.55% Burst cell as owned data.

## Loss

Per-metric ordinary least squares on `split=fit` only:

```
for M in cpu, p50, p95, p99, goodput, error_by_class, connections:
    minimize  Σ_{run in fit} (model(M, run) − measured(M, run))²
```

There is no composite loss. There is no step that raises `overallScore`.

## Coefficient shape

Every metric is `affine_in_target_rps`:

```
model(M, run) = intercept_M + slope_M * target_rps(run)
```

`cpu` is two independent affines (`app_cpu_avg` and `db_cpu`), not a blended CPU score. `error_by_class` is fit on published `error_rate` / `fail_rate`. Idle / normal / peak all have error_rate 0, so that OLS is the zero model — a caveat, not a reason to import the public 2% Burst literature cell.

Hold out:

- Burst (1000 RPS), including the three diagnostics
- a later day
- a second region

Those never enter the fit. After a fit they receive `fit_prediction` and `delta = measured − fit_prediction`.

Owned observations live in `fit_input.yaml` (copied from `holdout/REPORT.md` and `holdout/exports/473f1339.summary.md`). Peak app/db CPU use the published tilde values (8.63 / 8.22). Idle/normal `app_cpu_avg` is the mean of the two published app-host CPUs.

## What the fitter does

```bash
python3 calibrate/calibrate.py
# -> recomputes OLS from fit_input.yaml and checks coefficients.yaml matches

python3 calibrate/calibrate.py --write
# -> writes metrics.* and holdout fit_prediction/delta

python3 calibrate/calibrate.py --check-provenance
# -> exit 0 when SHA + fit_split (no Burst) + fitted metrics + holdout deltas

python3 calibrate/calibrate.py --composite-score
# -> exit 2, refuses
```

If you pass run JSON files, `isExample: true` documents are ignored. Real `split=fit` runs would be schema-validated and fit the same way; Burst in that split is refused. The v1 path does not commit claimed run JSON under `results/` (CI still rejects `isExample: false` there).

## Provenance

`coefficients.yaml` and `coefficients.schema.yaml` require:

| Field | After this fit |
| --- | --- |
| `measurement_sha` | `7416cb63ace3a7ab2e3486bb6f132a2dcb574c34` |
| `fit_split` | idle / normal / peak run ids (no Burst) |
| `holdout_deltas` | measured fields + `fit_prediction` + `delta` |
| `created_at` | `2026-09-06T03:44:51.130Z` (campaign export) |
| `metrics.*` | per-metric `affine_in_target_rps` objects |

A coefficients change without a new `measurement_sha` is rejected by `--check-provenance` and by CI. Burst in `fit_split` fails. Invented `fit_prediction` while `metrics.*` are null fails. Fitted metrics without holdout predictions fail.

## Accuracy page

The accuracy page **consumes** this dataset. It does not vote on coefficients. Do not retune anything to raise 94.7%. The public 2% / 9.55% Burst cell is not owned data. Owned CRUD Burst-class error on this workload is ≈ 0%. The fitted error model predicts 0 on CRUD rungs because the fit split measured 0.
