# CWM typical-v1 P95 model — DRAFT candidate (not implemented, not published)

Status: analysis-only draft, 2026-10-10. No engine, calibration, website or prediction file changed.

## Formula
Inputs (all known at prediction time): app server count `n`, total RPS `T`, per-node RPS `p = T/n`.

    pc = min(p, 300);  Tc = min(T, 300)
    core = exp(a + b*pc/100 + c*Tc/100)
    P95  = max(8.0 ms, P50, core * (1 + b*(p - pc)/100))

a = 1.0576, b = 0.7561, c = 0.4474 (natural log, ms). In words: P95 starts near 8 ms and multiplies by
about 2.13x for every extra 100 RPS a node handles, and by about 1.56x for every extra 100 RPS of total
traffic through the shared ALB/DB, whatever the server count.

Equivalent form: total RPS may be replaced by the engine's predicted DB CPU (it is linear in total RPS),
giving an identical fit; total RPS is preferred because it is simpler.

## Valid range
Fitted on 35 runs: 1/2/3 app servers, 20–300 total RPS, 10–300 RPS per node (typical-v1 fit day + 300
holdout, holdouts-v1-20261006, typical-scale-v1 sessions 1–3). Same topology gate as today (Node CRUD,
2 workers, 250-conn pool, MySQL 8.0, maxConnections=500, internal ALB).

## Extrapolation above the measured range
- Total RPS above 300: hold the total-traffic term at its 300 value (no further growth from it).
- Per-node RPS above 300: grow linearly along the tangent (not exponentially).
- Check: 2 servers @ 500 RPS → 73 ms (band 52–97); measured saturation-500 run 88.2 ms.
  Caveat: this rule was chosen after looking at that run, so it is not an independent check.
- Outside 1–3 servers or >500 total RPS: flag as low confidence.

## Uncertainty band
From leave-one-campaign-out residuals (10th/90th pct): low = 0.71 x central, high = 1.33 x central.

## Unchanged
App CPU, P50 (incl. its 300-RPS cap), P99 (not modeled here), DB CPU, throughput, errors, cost.
Only the P95 line of the owned / owned-scaled typical paths changes.

## Validation
All 36 runs (incl. typical-scale-v1) become fit data. The model needs the new holdout below before any
accuracy claim; typical-scale-v1 scores against this model are in-sample.

## Holdout plan (draft — not run, needs Kevin's AWS approval)
- Cells: 2x and 3x app servers, fresh seed (new stack), ladder run first at 300, then 200 → 100 (reverse).
  3 reps each = 6 applies, on at least 2 separate UTC days.
- Capture: per-minute k6 p50/p95/p99, ALB per-minute p95, app pool-wait and event-loop lag, DB connections,
  DB CPU, RDS engine version.
- Freeze predictions (this model, central + band) before the first apply.
- Pass criteria (set now): per cell, median-of-3 measured P95 within the 0.71–1.33x band in all 6 cells;
  median P95 metric score >= 80 across cells; and better than engine 1.2.14 in every 300 RPS cell.
  Fail on any 300-RPS cell outside band → model rejected / refit with new mechanism.
- Time/cost: ~76 min per 3-rung apply → ~7.6 h of stack time for 6 applies; at < $1/h ≈ $8
  (plus MySQL Extended Support surcharge). A 300-only variant (~30–35 min/apply) ≈ 3.5 h, ≈ $4.
