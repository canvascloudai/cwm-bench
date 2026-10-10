# Engine baseline (empty until the MCP freeze)

This directory must be filled by the MCP engine freeze before the first apply. Do not put a live query result anywhere else and then score from it.

- 9 cells: 1×, 2× and 3× at 300, 200 and 100 total RPS.
- Same graphs as the typical-scale-v1 payloads at the matching N and RPS (`typical/scale-v1/predictions/create-payload-<N>x-<RPS>.json`).
- Record the `engineVersion` returned by that freeze. Do not assume 1.2.14 or 1.2.17.
- Also record `calibrationEvidence.kind`, the calibration id, and the request and response JSON for each cell.
- The commit that adds those files is `measurement_sha`. Every apply uses that SHA as `app_source_git_ref`.

`typical/p95-v1/score_p95_v1.py` reads the candidate only from `../model-predictions.csv` and the engine only from a frozen file in this directory. It does not query a live engine. Until this directory is filled, engine page scores are unmeasured and verdict A-c cannot pass.
