# typical-p95-v1 engine baseline freeze

**FROZEN against live CWM engine 1.2.18** (not 1.2.14 or 1.2.17; recorded as returned).

- Freeze timestamp: **2026-10-10 10:06:24 EDT** (America/New_York). MCP calls ran 10:03–10:06 EDT.
- Protocol: typical-scale-v1 PREREGISTRATION §5.1. create (traffic at create, seed 20240601; typical-scale-v1 create payload with only `name` changed) → simulation.step once (currentStep=6) → simulation.cost_breakdown → simulation.delete. One simulation per cell; all 9 deleted.
- CalibrationId (all 9): `aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0` (fit source engine 1.2.3)
- Kinds: **owned** on all 2× cells, **owned-scaled** on all 1×/3× cells. The MCP schema no longer rejects `owned-scaled`, so every create/step body (including effectiveConfigHash) came back directly. No list/snapshot recovery was needed.
- No AWS, engine, Replit or PR actions.

## 9-cell table

| Cell | kind | app CPU %/host | DB CPU | P50 | P95 | P99 | thr | err | cost/hr | cost Σ | effectiveConfigHash |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1x-300 | owned-scaled | 29.027 | 25.8 | 4.165221 | 18.108190 | 108.602875 | 262.54028 | 0 | 0.78 | 0.783815 | b5e4b2cb… |
| 1x-200 | owned-scaled | 19.502 | 18.6 | 4.165221 | 14.558712 | 97.852498 | 175.0481 | 0 | 0.64 | 0.642078 | 4f6b4eef… |
| 1x-100 | owned-scaled | 9.978 | 11.4 | 4.522397 | 11.009235 | 87.102120 | 87.555916 | 0 | 0.50 | 0.500341 | ff83223e… |
| 2x-300 | owned | 14.74 | 25.8 | 4.165221 | 12.783974 | 92.477309 | 262.604 | 0 | 0.88 | 0.879919 | d9c1bcd2… |
| 2x-200 | owned | 9.978 | 18.6 | 4.522397 | 11.009235 | 87.102120 | 175.11183 | 0 | 0.74 | 0.738181 | 16052995… |
| 2x-100 | owned | 5.215 | 11.4 | 4.879573 | 9.234496 | 81.726931 | 87.619644 | 0 | 0.60 | 0.596444 | d4e9e77d… |
| 3x-300 | owned-scaled | 9.978 | 25.8 | 4.522397 | 11.009235 | 87.102120 | 262.66776 | 0 | 0.98 | 0.976022 | d962a197… |
| 3x-200 | owned-scaled | 6.803 | 18.6 | 4.760514 | 9.826076 | 83.518661 | 175.17555 | 0 | 0.83 | 0.834284 | 7aff8e7d… |
| 3x-100 | owned-scaled | 3.628 | 11.4 | 4.998632 | 8.642917 | 79.935201 | 87.68337 | 0 | 0.69 | 0.692547 | ab9595e5… |

Full hashes, per-app CPU, the error breakdown (all 13 components 0), connection demand, and predictionEvidence low/central/high are in predictions.json and raw/. Scored latencies use the full-precision predictionEvidence centrals. The rounded step-response values are stored too.

## Drift vs frozen 1.2.14 (typical-scale-v1/freeze/predictions.json)

Compared appCpuPerHost, dbCpu, P50, P95, P99, throughput, errorRate, costPerHour, costBreakdownTotal and kind (rel tol 1e-6): **no differences in any cell.** The 2× cells are identical to 1.2.14, and all 1×/3× cells are still owned-scaled. Only engineVersion changed (1.2.14 → 1.2.18).

## Scorer compatibility

Checked against `score_p95_v1.py` `load_engine_predictions` on branch cursor/typical-p95-v1-holdout-368e. It reads top-level `engineVersion`, `calibrationId`, and `cells["<N>x-<RPS>"].latencyP95`, and loads all 9 cells without error.
