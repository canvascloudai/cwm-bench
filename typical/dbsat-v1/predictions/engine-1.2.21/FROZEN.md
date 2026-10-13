# Engine 1.2.21 predictions for typical-dbsat-v1 (frozen, descriptive only)

Frozen 2026-10-13 (America/New_York) before any `measurement_sha`, per PREREGISTRATION.md §5. **Never scored, never used to pick steps** (§7.6). `score_dbsat_v1.py` does not read this directory.

- Engine: `1.2.21` on every create and step response (checked by `freeze_engine_1_2_21.py assemble`).
- Protocol (same as `typical/p95-v1/predictions/engine-baseline/`): user-cwm MCP `simulation.create` with `payloads/create-payload-<N>x-<RPS>.json` (appWeight typical, seed 20240601, us-east-2, internal ALB + N × m5.large crud-typical node/2 workers/pool 250 + db.r5.large MySQL 8.0 maxConnections 500, minInstances = maxInstances = N) → `simulation.step` once → `simulation.delete`. 21 cells: N ∈ {2,3,4} × RPS ∈ {300,500,700,900,1100,1300,1500}.
- Raw responses: `raw/<cell>.{create,step,delete}.json`. All 21 simulations were deleted (each delete returned an empty body).
- Assembled: `predictions.json`, `predictions.csv` (P95/P50 low/central/high from `predictionEvidence`, step P95/P50, per-resource CPU from the step, error rate, throughput, calibration kind/id).
- Scope wording (§5): 2–3 servers at ≤ 300 RPS are inside engine 1.2.21's validated typical P95 scope (`in_validated_scope=true`: 2×-300, 3×-300). 4 servers and every cell above 300 RPS are outside it; engine numbers there are extrapolations shown for comparison only.
- Cross-check: 2×-300 P95 central 34.2573 ms equals the value from the earlier engine 1.2.21 production check of the p95-v1 cells.

Reproduce: `python3 freeze_engine_1_2_21.py payloads <dir>`; make the three MCP calls per cell; save responses as above; `python3 freeze_engine_1_2_21.py assemble raw .`.
