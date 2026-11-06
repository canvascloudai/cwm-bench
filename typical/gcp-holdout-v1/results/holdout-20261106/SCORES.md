# gcp-holdout-v1 scoring

Archive `gcp-holdout-v1-redacted-20261106T083032Z.tar.gz`: 5 parts + archive SHA-256 verified (`ac2116f50f5184b74b590f4fb052f2a40c8deb2cdecce82b6cfc79e8660ccccf`). Scored against `typical/gcp-holdout-v1/PREREGISTRATION.md` at measurement pin `7ff414717b5360276794aee97b13f54408336aa9` (adapter **1.7.3**, amendment 2026-11-05). Frozen predictions and engine hashes were not edited.

Reps scored (no pooling, no rung retries):
- r1 = `gcp-holdout-v1-r1-20261106`; generator `us-central1-c`; apps `us-central1-b` + `us-central1-f`
- r2 = `gcp-holdout-v1-r2a-20261106`; generator `us-central1-a`; apps `us-central1-b` + `us-central1-c`

Rep 2's earlier zone-c attempt (`gcp-holdout-v1-r2-20261106`) was a pre-load generator stockout (no k6 / no collect). Its evidence is retained separately and is not scored.

Controller SHA-256 on both completed reps: `7546950fa8592a5b300b4be2496664f4fd67019d037883a1e0582f6a106da7ca` (`scripts/cwm-gcp-holdout.py`). Control-transport helper recorded separately as `483dea083cedeff5b20d544b31fe588d9016ad65f487c67c5914eb307fc5b804`. IAP reconnects: 0 on every rung. Zone is a covariate and is not scored.

Frozen engine identity (local build, not deployed): query `2026-11-06T03:00:45.253Z` (2026-11-05 10:00:45 PM ET); evaluator `sha256:e6eb5498b9d872a4d4dc412219bf5f61b20327885bf1226ff1d1ebbac8838493`; receipt `fc750434cbddeae7b0e2af13ca8d62e611047f2a9b176c074efc9a5f41e7600e`. Predicted breakpoint: **500** RPS (assumed midpoint of the gcp-fit-v1 `(400, 600]` bracket).

Method: latency and error rate independently recomputed from raw `k6.json.gz` over each `NNN-steady-window.json` (`recompute.py`, nearest-rank `ceil(p·N)-1`, same rule as the prereg). Collect-doc P95 agreed with these steady-only values within ~1 ms. Saturation is the prereg binary: steady `http_req_failed` rate **> 1%**. Latency bands use `|predicted − measured| / measured`: pass ≤ 20%, marginal > 20% and ≤ 35%, fail > 35%. Latency is scored only when the error rate is ≤ 1%. Per-rep results are primary. A cross-rep mean is computed only when **both** reps are latency-scored at that rung. Interpolation / replication / extrapolation are never combined into one score. See `scores.csv` for the full table.

## Latency (primary)

| rung | label | pred P95 ms | r1 P95 | r1 rel | r1 latency | r2 P95 | r2 rel | r2 latency | mean P95 | mean rel | mean latency |
|---:|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| 300 | interpolation | 77.525 | — | — | unscored (saturated) | 44.042 | 76.03% | fail | — | — | not computed (r1 unscored) |
| 400 | replication | 98.700 | 155.421 | 36.49% | fail | 79.109 | 24.76% | marginal | 117.265 | 15.83% | pass |
| 500 | extrapolation | 119.875 | 284.980 | 57.94% | fail | 99.854 | 20.05% | marginal | 192.417 | 37.70% | fail |

r2 500 is just over the pass line (20.05% > 20%). The 400 mean passes only because r1's 155 ms and r2's 79 ms bracket the 98.7 ms prediction; that mean mixes the degraded r1 apply (see anomalies) with the healthy r2 apply. Per the prereg, the per-rep verdicts are primary.

## Saturation

| rung | pred saturated | r1 err | r1 sat | r1 verdict | r2 err | r2 sat | r2 verdict |
|---:|:---:|---:|:---:|:---:|---:|:---:|:---:|
| 300 | No | 45.95% | Yes | miss | 0.0048% | No | hit |
| 400 | No | 0.049% | No | hit | 0.031% | No | hit |
| 500 | Yes (assumed) | 0.013% | No | miss | 0.0064% | No | miss |

Breakpoint:
- r1: saturated at 300, then clean at 400 and 500. Non-monotonic → breakpoint **undetermined** → breakpoint **not scored**. Each rung's binary verdict is still scored above.
- r2: no rung saturates → measured breakpoint **> 500**. Frozen prediction 500 is not inside `(500, ∞)` → breakpoint **miss**.
- Supporting DB connections vs `max_connections=500`: r1 stayed at avg 256–257 / max 256–258 on every rung (below the 500 cap, but pinned near one pool of 250). r2 was avg 68.6 / max 76 at 300, 101.5 / 112 at 400, and 153.2 / 157 at 500.

## Cost

Every collect has `cost.source=unmeasured`. Every rung: `cost: unscored (billing export unavailable)`. Missing cost is null, not zero. Billing export was still pending when the archive was packed.

## Secondary metrics (reported, not band-scored)

| rung | pred P50 | r1 P50 | r2 P50 | pred app CPU/node | r1 app CPU high/low (mean) | r2 app CPU high/low (mean) | pred DB CPU | r1 DB CPU | r2 DB CPU | pred conns | r1 conns avg/max | r2 conns avg/max |
|---:|---:|---:|---:|---:|---|---|---:|---:|---:|---:|---|---|
| 300 | 11.70 | 18.42 | 10.12 | 27.45% | 35.49 / 0.26 (17.88) | 26.86 / 26.77 (26.81) | 44.05% | 84.79% | 40.55% | 76 | 256.8 / 258 | 68.6 / 76 |
| 400 | 12.25 | 11.17 | 10.42 | 35.20% | 57.00 / 0.22 (28.61) | 31.71 / 31.64 (31.68) | 57.60% | 53.86% | 53.13% | 111 | 255.8 / 256 | 101.5 / 112 |
| 500 | 12.80 | 21.17 | 11.36 | 42.95% | 69.67 / 0.26 (34.97) | 39.46 / 39.14 (39.30) | 71.15% | 66.55% | 65.58% | 270.5 | 255.8 / 257 | 153.2 / 157 |

P99 (reported, not scored): r1 7527.7 / 284.8 / 469.9 ms; r2 131.2 / 165.5 / 202.4 ms. Generator CPU (not scored): r1 4.68 / 7.20 / 8.53%; r2 5.96 / 7.73 / 8.87%. App per-node RPS is null in every collect (LB metric not collected). Egress from k6 `data_received` in the steady window (generator-side response bytes, not billed egress): r1 3.19 / 12.55 / 15.97 GB/hr; r2 9.60 / 12.80 / 16.04 GB/hr.

On the healthy r2 apply, P50, app CPU, DB CPU, and 300/400 connections track the frozen values closely. The 500-RPS connection prediction (270.5) is a diagnostic extrapolation and overshot the measured 153 avg.

## Anomalies

1. **r1 served like a one-node MIG (verified).** On every r1 rung one app node stayed at 0.22–0.26% CPU while the other scaled 35.5% → 57.0% → 69.7%. DB connections locked at ~256 (max 256–258) against two declared pools of 250 and `max_connections=500`. Both app VMs were `RUNNING` at pre-destroy. The `us-central1-f` app was created at 11:58:04 PM ET on 2026-11-05, about 1.5 minutes after r1's 300-RPS k6 launch (11:56:30 PM ET); the `us-central1-b` app had been up since 11:50:25 PM ET. r2's two app VMs were both up from about 1:29 AM ET, seven minutes before its 300-RPS launch (1:36:03 AM ET), and split CPU evenly.
2. **r1 300 was a hard error storm (verified).** Steady error rate 45.95% (124056/269987): HTTP 503 = 88872, 500 = 11644, 404 = 23537, 401 = 3. Goodput 162.1 RPS against 300.0 achieved RPS. Collect classified large `queue_full` and `internal` counts. No other scored rung produced any 404s. Then r1 400 and r1 500 held the target rate with 0.049% and 0.013% errors (almost all 503s). That is a non-monotonic saturation ladder, so r1's breakpoint is undetermined rather than "≤ 300".
3. **Inferred, not used to change any score:** only one r1 app process accepted work (one pool near 250 connections; one node idle for the whole apply). The late-created `us-central1-f` instance is the likely non-serving backend, but backend health-check series are not in the collect docs, so that assignment is inferred. The 300-RPS storm at 35.5% CPU on the busy node, followed by clean 400 and 500 rungs at 57% and 70% on that same node, is more consistent with a first-rung degraded-MIG / startup event than with this topology's intrinsic 300-RPS capacity. Workload errors are results under the prereg; r1 is scored, not replaced.
4. **r2 300 P95 is much faster than predicted (verified).** 44.042 ms vs 77.525 ms (76.03% relative error, fail). r2 P50 at 300 is 10.12 vs 11.70, so the miss is a lighter tail, not a shifted median. r2 400 (79.109 vs 98.700, marginal) and r2 500 (99.854 vs 119.875, marginal) are also faster than predicted. Comparison only, not pooling: gcp-fit-v1's clean 400-RPS P95 means were about 98.7 ms; this holdout's healthy replication rung did not reproduce that fit P95.
5. **r2 app zones differ from the fit (verified, covariate).** gcp-fit-v1 placed apps in `b`+`f` on both reps. This holdout's r1 also landed in `b`+`f`; r2 landed in `b`+`c`. Zone is not scored.
6. **r1 apply id is unsuffixed** (`…-r1-20261106`) even though the generator ran in zone `c`. The prereg allows a `c` suffix; this does not affect scoring.

## Overall

No single combined score (prereg forbids merging the three rung labels).

- **Interpolation (300):** r1 latency unscored (saturated) and saturation miss; r2 latency fail (measured much faster than predicted) and saturation hit. No cross-rep mean.
- **Replication (400):** r1 latency fail, r2 latency marginal; both saturation hits. Cross-rep mean latency pass (15.83%), but that mean is not primary and averages a one-node r1 with a two-node r2.
- **Extrapolation (500):** r1 latency fail, r2 latency marginal (20.05%); both saturation misses (neither rep exceeded 1% errors). Cross-rep mean latency fail.
- **Saturation / breakpoint:** the frozen "saturated at 500" call missed on both completed reps. r1 breakpoint undetermined (not scored). r2 breakpoint `> 500` (miss vs predicted 500).
- **Cost:** unscored (billing export unavailable).

On the only apply that matched the intended two-serving-node shape (r2), resource secondaries mostly tracked the fit, latency came in faster than the frozen P95s (fail / marginal / marginal), and the topology did not saturate by 500 RPS.
