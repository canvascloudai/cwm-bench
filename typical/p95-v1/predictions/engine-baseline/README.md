# Engine baseline (frozen)

Frozen live CWM engine **1.2.18**, timestamp **2026-10-10 10:06:24 EDT**. One simulation per cell. 2× is **owned**. 1× and 3× are **owned-scaled**. All 9 `effectiveConfigHash` values are in `predictions.json` and `raw/`. Every scored field matches the frozen 1.2.14 values; only `engineVersion` changed. The commit that adds this directory's freeze is `measurement_sha`.

What is captured:

- `predictions.json` — the file `score_p95_v1.py` loads. Top-level `engineVersion`, `calibrationId`, and `cells["<N>x-<RPS>"].latencyP95` for all 9 cells.
- `payloads/` — the exact `simulation.create` request bodies (`create-payload-<N>x-<RPS>.json`).
- `raw/` — harvested response fields per cell (CPU, latency centrals and `predictionEvidence`, throughput, errors, cost, connection demand, `effectiveConfigHash`, simulation id). These are not full engine responses.
- `call-log.json` — one row per MCP call (`simulation.create`, `simulation.step`, `simulation.cost_breakdown`, `simulation.delete`) with the simulation id.
- `FROZEN.md` — the freeze note and the 9-cell table.

Full raw response bodies were not saved as separate files.

`typical/p95-v1/score_p95_v1.py` reads the candidate only from `../model-predictions.csv` and the engine only from `predictions.json`. It does not query a live engine.
