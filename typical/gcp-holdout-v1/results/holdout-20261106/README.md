# gcp-holdout-v1 results (2026-11-06) — FAILED holdout

These are scored results for the gcp-holdout-v1 campaign preregistered in `../../PREREGISTRATION.md` (including the 2026-11-05 amendment). This holdout **failed**. No per-rep latency pass occurred, and the frozen saturation-at-500 prediction missed on both completed reps. The candidate calibration was disabled in production behind a default-off flag and was never published as an accuracy claim.

Private campaign archive: `gcp-holdout-v1-redacted-20261106T083032Z.tar.gz`  
SHA-256: `ac2116f50f5184b74b590f4fb052f2a40c8deb2cdecce82b6cfc79e8660ccccf`

Measurement pin: `7ff414717b5360276794aee97b13f54408336aa9` (adapter **1.7.3**). Frozen predictions and engine hashes were not edited. Scores are unchanged from `SCORES.md` / `scores.csv` in this directory.

## Verdict

**FAILED holdout.** Per the prereg, per-rep latency verdicts are primary. There is no single combined score.

- No per-rep latency pass at any rung.
- The frozen "saturates at 500 RPS" call missed on both completed reps.
- Cost is unscored (billing export unavailable).
- Nothing here should be published as a GCP accuracy claim.

## Per-rep latency (primary)

| rung | label | pred P95 ms | r1 latency | r2 latency |
|---:|---|---:|---|---|
| 300 | interpolation | 77.525 | unscored (saturated; 45.95% errors) | fail (44.042 ms, 76.03% rel) |
| 400 | replication | 98.700 | fail (155.421 ms, 36.49% rel) | marginal (79.109 ms, 24.76% rel) |
| 500 | extrapolation | 119.875 | fail (284.980 ms, 57.94% rel) | marginal (99.854 ms, 20.05% rel) |

## Saturation / breakpoint

| rung | pred saturated | r1 | r2 |
|---:|:---:|---|---|
| 300 | No | miss (saturated) | hit |
| 400 | No | hit | hit |
| 500 | Yes (assumed) | miss (not saturated) | miss (not saturated) |

- r1 breakpoint undetermined (non-monotonic: saturated at 300, then clean at 400 and 500) → not scored.
- r2 measured breakpoint **> 500** → miss vs predicted 500.

## Anomalies

1. **r1 one-serving-node MIG (verified).** On every r1 rung one app node stayed near 0.22–0.26% CPU while the other scaled 35.5% → 57.0% → 69.7%. DB connections locked at ~256 against two declared pools of 250 and `max_connections=500`. Both app VMs were `RUNNING` at pre-destroy.
2. **Late zone-f instance (inferred cause; scores unchanged).** The `us-central1-f` app was created about 1.5 minutes after r1's 300-RPS k6 launch; the `us-central1-b` app had been up earlier. Backend health-check series are not in the collect docs, so assigning the idle node to zone f is inferred. Workload errors are results under the prereg; r1 is scored, not replaced.
3. **r1 300 hard error storm (verified).** Steady error rate 45.95% (mostly HTTP 503/500/404). Then r1 400 and r1 500 held target with <0.05% errors.

## Production status

The additive gcp-fit-v1 calibration candidate was disabled in production behind server-side flag `CWM_ENABLE_GCP_FIT_V1` (default OFF; only exact `true` enables). With the flag off, `gcpFitPrediction` / gcp-fit-v1 blocks are withheld from API/UI, history, async jobs, stateless responses, and hosted MCP compact/full outputs. It is not an accuracy claim.

## Reproduce scoring

```bash
python3 recompute.py   # steady-only P95/error from raw k6 over NNN-steady-window.json
```

See `SCORES.md` for the full write-up and `scores.csv` for the table.
