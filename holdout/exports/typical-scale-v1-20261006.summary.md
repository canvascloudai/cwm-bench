# typical-scale-v1-20261006: scored summary

Engine 1.2.14 frozen predictions (`typical/scale-v1/predictions/predictions.json`), measurement SHA `06e4048d9c6db5494dbb85da2911de4943a70383`, AMI `ami-0d3d85815a9746bc5`. Scored with `score_scale.py` (rel/errs/W from `typical/after-fit/score_export.py`, unchanged). Medians of 3 reps; sessions S1 2026-10-06, S2 2026-10-07, S3 2026-10-09 (3x = r3a replacement).

Integrity: PASS (27 rungs, 10 applies incl. the no-load failed 3x-r3). Failures: none

## Absolute (median measured / predicted)

| Cell | kind | CPU % | P50 ms | P95 ms | goodput rps | err % | DB CPU % | total connector [min–max] | total no-egress [min–max] | no-cost | P99 diag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1x-100 | owned-scaled | 9.97 / 9.98 | 3.52 / 4.52 | 9.13 / 11.01 | 87.62 / 87.56 | 0.0029 / 0 | 12.37 / 11.4 | 85.2 [77.6–89.6] | 89.1 [81.5–93.6] | 87.9 | 97.0 |
| 1x-200 | owned-scaled | 17.88 / 19.50 | 4.00 / 4.17 | 37.45 / 14.56 | 175.11 / 175.05 | 0.0067 / 0 | 19.02 / 18.6 | 74.2 [72.0–76.0] | 82.1 [79.8–83.8] | 80.1 | 80.8 |
| 1x-300 | owned-scaled | 27.49 / 29.03 | 4.18 / 4.17 | 94.99 / 18.11 | 262.58 / 262.54 | 0.0168 / 0 | 26.70 / 25.8 | 64.5 [64.0–65.0] | 74.5 [74.0–75.0] | 71.7 | 60.4 |
| 2x-100 | owned | 4.93 / 5.21 | 4.76 / 4.88 | 8.36 / 9.23 | 87.62 / 87.62 | 0.0038 / 0 | 11.91 / 11.4 | 92.5 [91.2–93.9] | 95.7 [94.4–97.1] | 95.2 | 93.2 |
| 2x-200 | owned | 9.33 / 9.98 | 5.03 / 4.52 | 15.09 / 11.01 | 175.12 / 175.11 | 0.0024 / 0 | 18.80 / 18.6 | 83.6 [74.8–89.5] | 89.8 [81.1–95.8] | 88.7 | 96.7 |
| 2x-300 | owned | 13.83 / 14.74 | 5.11 / 4.17 | 41.31 / 12.78 | 262.60 / 262.60 | 0.0022 / 0 | 26.33 / 25.8 | 68.4 [68.1–70.9] | 77.7 [77.5–80.3] | 75.3 | 83.8 |
| 3x-100 | owned-scaled | 3.49 / 3.63 | 4.85 / 5.00 | 8.74 / 8.64 | 87.62 / 87.68 | 0.0000 / 0 | 11.66 / 11.4 | 95.8 [94.0–95.8] | 98.4 [96.6–98.4] | 98.2 | 91.3 |
| 3x-200 | owned-scaled | 6.64 / 6.80 | 4.80 / 4.76 | 12.05 / 9.83 | 175.11 / 175.18 | 0.0052 / 0 | 18.56 / 18.6 | 89.6 [85.3–89.8] | 94.7 [90.4–94.9] | 94.1 | 93.5 |
| 3x-300 | owned-scaled | 9.35 / 9.98 | 4.56 / 4.52 | 20.74 / 11.01 | 262.61 / 262.67 | 0.0035 / 0 | 25.44 / 25.8 | 79.0 [77.1–81.4] | 86.8 [84.9–89.2] | 85.3 | 92.4 |

## Delta accuracy (§7.2/7.3)

| transition | rung | metric | meas % / Δpp | pred % / Δpp | B detect | meas dir | pred dir | dir ok | magnitude ok | paired dir | session-sensitive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2to1 | 100 | cpu | +102.4% | +91.3% | 1.093 | up | up | True | True | up | False |
| 2to1 | 100 | p50 | -26.0% | -7.3% | 1.200 | down | none | False | True | indeterminate | True |
| 2to1 | 100 | p95 | +9.1% | +19.2% | 1.283 | none | none | True | None | none | False |
| 2to1 | 100 | db | +3.9% | +0.0% | 1.172 | none | none | True | None | none | False |
| 2to1 | 100 | goodputPct | +0.0002 | -0.0637 | ±1 pp | none | none | True | True | none | False |
| 2to1 | 100 | err | -0.0010 | +0.0000 | ±0.01 pp | none | none | True | True | none | False |
| 2to1 | 200 | cpu | +91.5% | +95.4% | 1.093 | up | up | True | True | up | False |
| 2to1 | 200 | p50 | -20.4% | -7.9% | 1.200 | down | none | False | True | indeterminate | True |
| 2to1 | 200 | p95 | +148.3% | +32.2% | 2.707 | none | none | True | None | none | False |
| 2to1 | 200 | db | +1.1% | +0.0% | 1.196 | none | none | True | None | none | False |
| 2to1 | 200 | goodputPct | -0.0040 | -0.0319 | ±1 pp | none | none | True | True | none | False |
| 2to1 | 200 | err | +0.0043 | +0.0000 | ±0.01 pp | none | none | True | True | none | False |
| 2to1 | 300 | cpu | +98.8% | +96.9% | 1.051 | up | up | True | True | up | False |
| 2to1 | 300 | p50 | -18.0% | +0.0% | 1.120 | down | none | False | True | down | False |
| 2to1 | 300 | p95 | +129.9% | +41.6% | 1.899 | up | none | False | True | indeterminate | True |
| 2to1 | 300 | db | +1.4% | +0.0% | 1.197 | none | none | True | None | none | False |
| 2to1 | 300 | goodputPct | -0.0079 | -0.0212 | ±1 pp | none | none | True | True | none | False |
| 2to1 | 300 | err | +0.0146 | +0.0000 | ±0.01 pp | up | none | False | False | indeterminate | True |
| 2to3 | 100 | cpu | -29.1% | -30.4% | 1.093 | down | down | True | True | down | False |
| 2to3 | 100 | p50 | +2.0% | +2.4% | 1.200 | none | none | True | None | none | False |
| 2to3 | 100 | p95 | +4.5% | -6.4% | 1.283 | none | none | True | None | none | False |
| 2to3 | 100 | db | -2.1% | +0.0% | 1.172 | none | none | True | None | none | False |
| 2to3 | 100 | goodputPct | +0.0034 | +0.0637 | ±1 pp | none | none | True | True | none | False |
| 2to3 | 100 | err | -0.0038 | +0.0000 | ±0.01 pp | none | none | True | True | none | False |
| 2to3 | 200 | cpu | -28.9% | -31.8% | 1.093 | down | down | True | True | down | False |
| 2to3 | 200 | p50 | -4.4% | +5.3% | 1.200 | none | none | True | None | none | False |
| 2to3 | 200 | p95 | -20.1% | -10.7% | 2.707 | none | none | True | None | none | False |
| 2to3 | 200 | db | -1.3% | +0.0% | 1.196 | none | none | True | None | none | False |
| 2to3 | 200 | goodputPct | -0.0027 | +0.0319 | ±1 pp | none | none | True | True | none | False |
| 2to3 | 200 | err | +0.0029 | +0.0000 | ±0.01 pp | none | none | True | True | none | False |
| 2to3 | 300 | cpu | -32.4% | -32.3% | 1.051 | down | down | True | True | down | False |
| 2to3 | 300 | p50 | -10.7% | +8.6% | 1.120 | none | none | True | None | none | False |
| 2to3 | 300 | p95 | -49.8% | -13.9% | 1.899 | down | none | False | True | indeterminate | True |
| 2to3 | 300 | db | -3.4% | +0.0% | 1.197 | none | none | True | None | none | False |
| 2to3 | 300 | goodputPct | +0.0034 | +0.0213 | ±1 pp | none | none | True | True | none | False |
| 2to3 | 300 | err | +0.0013 | +0.0000 | ±0.01 pp | none | none | True | True | none | False |

## Transition verdicts

- **2to1: Does not predict the change**. Failing: 300 p95 direction (meas up, pred none); 300 err direction (meas up, pred none); 300 C8 errors (pred +0.0000 pp vs meas +0.0146 pp); P95 magnitude within ×/÷2 at 1/3 rungs (judged only where measured direction is up/down: 100:none, 200:none, 300:up)
- **2to3: Does not predict the change**. Failing: 300 p95 direction (meas down, pred none); P95 magnitude within ×/÷2 at 1/3 rungs (judged only where measured direction is up/down: 100:none, 200:none, 300:down)

## C9 diminishing returns

- 100 RPS: gain12 1.09, gain23 0.96 (pred 1.19/1.07); 2→1 P95 none, 2→3 P95 none (pred none); DB none/none → measured DR **does not hold**, CWM captures: True
- 200 RPS: gain12 2.48, gain23 1.25 (pred 1.32/1.12); 2→1 P95 none, 2→3 P95 none (pred none); DB none/none → measured DR **does not hold**, CWM captures: True
- 300 RPS: gain12 2.30, gain23 1.99 (pred 1.42/1.16); 2→1 P95 up, 2→3 P95 down (pred none); DB none/none → measured DR **holds**, CWM captures: False

## C1 baseline

- 100: cpu 4.926 in [4.792, 6.258], p50 4.759 in [3.776, 6.528], p95 8.364 in [5.947, 12.56], thr 87.62 in [87.62, 87.63], err 0.003804 in [0, 0.005753], db 11.91 in [9.806, 15.79]
- 200: cpu 9.334 in [9.119, 10.89], p50 5.028 in [3.841, 5.531], p95 15.09 in [6.003, 21.65], thr 175.1 in [175.1, 175.2], err 0.002379 in [0.003286, 0.009086] **BASELINE_DRIFT**, db 18.8 in [15.79, 21.83]
- 300: cpu 13.83 in [14.56, 16.91] **BASELINE_DRIFT**, p50 5.105 in [4.126, 5.797], p95 41.31 in [14.17, 97.08], thr 262.6 in [262.5, 262.7], err 0.002221 in [0.0009077, 0.009565], db 26.33 in [22.71, 36.95]

## C12 connection limits

| cell | budget | too_many_connections | queue_full | per-rep errors (classes) | DB conn max per rep | spike minute UTC per rep |
|---|---|---|---|---|---|---|
| 1x-100 | 250 | 0 | 0 | {'unclassified': 1}; {'unclassified': 3}; {'unclassified': 4} | 89, 38, 19 | 21:00, 19:30, 18:15 |
| 1x-200 | 250 | 0 | 0 | {'unclassified': 24}; {'unclassified': 13}; {'unclassified': 14} | 113, 211, 89 | 21:30, 20:00, 18:30 |
| 1x-300 | 250 | 0 | 0 | {'unclassified': 56}; {'unclassified': 53}; {'unclassified': 37} | 123, 210, 90 | 21:47, 20:06, 18:46 |
| 2x-100 | 500 | 0 | 0 | {'unclassified': 7}; {'unclassified': 2}; {'unclassified': 4} | 39, 21, 19 | 19:33, 22:48, 16:22 |
| 2x-200 | 500 | 0 | 0 | {'unclassified': 5}; {'unclassified': 4}; {'unclassified': 8} | 41, 153, 43 | 19:45, 23:02, 16:45 |
| 2x-300 | 500 | 0 | 0 | {'unclassified': 7}; {'unclassified': 6}; {'unclassified': 12} | 72, 158, 336 | 20:15, 23:30, 17:03 |
| 3x-100 | 750 | 0 | 0 | none; {'unclassified': 3}; none | 24, 28, 26 | 22:45, 21:11, 14:45 |
| 3x-200 | 750 | 0 | 0 | {'unclassified': 13}; {'unclassified': 11}; {'unclassified': 10} | 243, 83, 162 | 23:05, 21:30, 15:00 |
| 3x-300 | 750 | 0 | 0 | {'unclassified': 12}; {'unclassified': 7}; {'unclassified': 11} | 243, 84, 212 | 23:17, 21:42, 15:30 |

CWM predicted errorRate 0 in every cell (no connection-class errors); pool warnings on 1x (250 ceiling) and 3x (750 vs 500).

## C13 naive per-node CPU reference

The §5.3 reference equals CWM's frozen CPU in all 9 cells to 3 decimals, so C13 results are identical to C3/C4 (direction and ±20% magnitude pass at all 6 transition rungs).

## RDS engine versions

- typical-scale-1x-r1-20261006: `8.0.46` (apply start 2026-10-06T20:43:17.954Z)
- typical-scale-1x-r2-20261007: `8.0.46` (apply start 2026-10-07T19:15:11.477Z)
- typical-scale-1x-r3-20261009: `8.0.46-rds.20260908` (apply start 2026-10-09T17:50:52.232Z)
- typical-scale-2x-r1-20261006: `8.0.46` (apply start 2026-10-06T19:08:58.245Z)
- typical-scale-2x-r2-20261007: `8.0.46` (apply start 2026-10-07T22:26:05.538Z)
- typical-scale-2x-r3-20261009: `8.0.46-rds.20260908` (apply start 2026-10-09T16:03:40.054Z)
- typical-scale-3x-r1-20261006: `8.0.46` (apply start 2026-10-06T22:20:29.188Z)
- typical-scale-3x-r2-20261007: `8.0.46` (apply start 2026-10-07T20:49:50.510Z)
- typical-scale-3x-r3-20261008: `8.0.46-rds.20260908` (apply start 2026-10-08T23:23:57.099Z)
- typical-scale-3x-r3a-20261009: `8.0.46-rds.20260908` (apply start 2026-10-09T14:22:23.079Z)

Sessions 1–2: ['8.0.46']; session 3: ['8.0.46-rds.20260908']. Same build: False → possible confound (session 3 only).
