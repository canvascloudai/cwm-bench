# typical/dbsat-pscap24630-2x-v1 — Results: — H1 (PASS, PASS)

Scores the holdout preregistered in `typical/dbsat-pscap24630-2x-v1/PREREGISTRATION.md` with the frozen `score.mjs` (sha256 `43d64b75…ba4a`, unmodified, main @ `ea836034`) and `predict.mjs` (sha256 `447eb18f…41ad`, pinned in every forecast record).

## Claim tested
Given the measured rung start times, CWM predicts the rung in which MySQL first hits its prepared-statement limit (errno 1461) for this topology (2× m5.large + db.r5.large, MySQL 8.0, max_connections 500), cap 24,630 and schedule. Cap and schedule were chosen from development campaigns.

## Result
| Rep | Predicted rung | First 1461 rung | Onset into rung | Earlier 1461 | Gap/boundary | Verdict |
|---|---|---|---|---|---|---|
| r1 | 700 | 700 | 337 s (prior poll at 322 s had 0) | none | clearly inside (rung 0–1,229 s) | PASS |
| r2 | 700 | 700 | 359 s (prior poll at 344 s had 0) | none | clearly inside (rung 0–1,229 s) | PASS |

**Campaign verdict: H1** (both slots PASS, 0 replacements, no deviations).

Descriptive only (not part of the verdict):
- Timing error, onset minus schedule-conditioned forecast: r1 −383 s (forecast 720 s into the rung), r2 −286 s (forecast 645 s). The forecast was late in both reps; the rung-level margin held.
- State-anchored forecast (known to be biased early) predicted a crossing at the start of the 700 rung; onset came 337 s / 359 s after it.
- At onset: Prepared_stmt_count 24,630 (= cap), Threads_connected ~470/500, errno 1040 = 0; RDS CPU ~81–87% (1-min avg). Not connection- or CPU-limited.

## Evidence checks
- Live `max_prepared_stmt_count` = 24630 and parameter group in-sync before load (both reps); all E1–E10 gates true.
- Forecast records written 0.2–0.8 s after each rung's workload start (deadline 30 s); input/output hashes recompute under the frozen predictor.
- Max observer poll gap 15.2 s (limit 30 s).
- Committed here: `evidence-r1.json`/`evidence-r2.json` (the exact score.mjs inputs, built from the redacted archive by `build_evidence.py`), `poll-series-r*.csv`, `run_score.mjs`, and `scores.json` (its output). Reproduce: `node typical/dbsat-pscap24630-2x-v1/results/holdout-20261027/run_score.mjs`.
- Measurement manifest `34c64f23…91d6`, controller `af89bf2f…6be6`, as approved before apply.
- Account-redacted archive sha256 `10e79ad3f2db84a0076e0bbe7c4362e2722a8cbf3147894b9a9026b6347c2596` (private). It differs from the scored original only by `[AWS_ACCOUNT_ID]` substitutions in 123 files; none of the scoring inputs changed, and rescoring it gives the identical result.
- Scored original archive sha256 `88394d128c03eb9716ca4edaf46cc80a86d22c9787d5787698953e5abc4af61c`, kept privately and unchanged.
- Conservative spend bound: **$5.87** (not the AWS bill).

AWS account IDs and ARNs are omitted from this PR.
