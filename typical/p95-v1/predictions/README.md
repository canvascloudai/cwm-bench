# typical-p95-v1 candidate predictions

Frozen candidate model for `typical/p95-v1`. These files are the scored predictor. The engine baseline is frozen in `engine-baseline/` (engine 1.2.18).

| File | Role |
| --- | --- |
| `recommended-params.json` | Frozen coefficients. sha256 `fd0c1a379c0c3bce0a818cbafcb6eaf718913b6cb48d7585df79668b4c37b0de`. |
| `predict_p95.py` | Stdlib only. No fitting. `python3 predict_p95.py` prints `model-predictions.csv`. |
| `model-predictions.csv` | The nine cell central values `score_p95_v1.py` reads. It does not recompute them from the formula at score time. |

`engine-baseline/` holds the frozen engine 1.2.18 baseline. `score_p95_v1.py` loads `engine-baseline/predictions.json`.
