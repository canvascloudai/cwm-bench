# gcp-holdout-v2 results (2026-11-06) — holdout met preregistered criteria

These are scored results for the gcp-holdout-v2 campaign preregistered in `../../PREREGISTRATION.md`. Two fresh applies (r1, r2), each 300 → 400 → 500 RPS with 300 s warmup + 900 s steady. 0 replacements, 0 rung retries, 0 runner faults. All six backend-health gates passed with 2/2 healthy backends, and both app VMs carried load on every rung.

Private campaign archive: `gcp-holdout-v2-redacted-20261107T005636Z.tar.gz`  
SHA-256: `69522cc39070b0fb80b6406e6c28ea189000633c838102b370190041d478adf2`

Measurement pin: `409bf88943758c920825b59f1027884e7ec74460` (merge of the v2 prereg, adapter **1.7.5**). Frozen predictions (engine 1.2.71, evaluator `sha256:74a7876a…a434`) and the estimator were not edited.

## Verdict

**The holdout met the preregistered latency and saturation criteria.** Per the prereg, per-rep verdicts are primary. There is no single combined score.

- Latency (P95): 5 of 6 rungs pass, 1 marginal (r1 500 at 20.42%), 0 fail. Cross-rep means pass at 300, 400 and 500.
- Saturation: 6 of 6 hits (predicted not saturated; measured ≤ 0.04% errors). Breakpoint `> 500` on both reps → hit vs the assumed 550 onset. This ladder cannot discriminate the onset itself.
- Cost: unscored (billing not final).

Scope: every rung is a **replication** at a fitted load (gcp-holdout-v1 r2 became fit data). This does not test unseen loads or the 550-RPS onset. Measured P95 ran above prediction on every rung. `CWM_ENABLE_GCP_FIT_V1` remains default OFF and nothing was deployed. Activation or accuracy-page use is a separate decision and is not made here.

## Per-rep latency (primary)

| rung | pred P95 ms | r1 | r2 | cross-rep mean |
|---:|---:|---|---|---|
| 300 | 68.655 | pass (77.806 ms, 11.76%) | pass (70.856 ms, 3.11%) | pass (74.331 ms, 7.64%) |
| 400 | 86.161 | pass (95.257 ms, 9.55%) | pass (91.777 ms, 6.12%) | pass (93.517 ms, 7.87%) |
| 500 | 103.667 | marginal (130.263 ms, 20.42%) | pass (110.113 ms, 5.85%) | pass (120.188 ms, 13.75%) |

## Anomalies (details in `SCORES.md`)

1. Post-workload controller process loss on 2026-11-07, 3:22–3:25 AM ET. Recovery only: no replay, no new applies, archive unchanged.
2. r1 500 DB connections averaged 278.5 vs a frozen 146.5 (r2: 132.5), with balanced app CPU. This coincides with the only marginal latency rung.
3. 18% cross-rep P95 spread at 500 RPS. Heavy P99 tail (385–571 ms) on every rung.
4. 5 of 6 raw run dirs lack `exit.code`. A clean exit (0) is recorded in the adapter run output and completion markers.
5. Cleanup: the latest clearance receipt reports `allAttemptResourcesClear: true` for both reps (0 resources across 15 types). Read-only post-release sweeps are still due 2026-11-11 5:36 PM ET and 7:05 PM ET.

## Privacy

Own scan over all 640 files with every gzip payload decompressed (`redaction_scan.sh`). No project id, project number, billing id, or service-account email. Only redaction placeholders and Google's public `rocky-linux-cloud` image project appear. This directory contains no identifiers.

## Reproduce scoring

```bash
# from the extracted archive root
python3 recompute.py score gcp-holdout-v2/evidence scores.csv
```

`recompute.py raw <k6.json.gz> <NNN-steady-window.json>` recomputes one rung: steady-only nearest-rank from raw k6 samples, with a `phase=steady` cross-check.
