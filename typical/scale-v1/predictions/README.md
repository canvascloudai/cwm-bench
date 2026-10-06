# typical-scale-v1 frozen predictions

Engine **1.2.14**, frozen **2026-10-06 12:41:17 EDT**. The campaign definition is `typical/scale-v1/PREREGISTRATION.md`.

Scoring reads `predictions.json`. It does not call the live engine. `call-log.json` is the same harvest, one simulation per cell. `FROZEN.md` is the display table and the warning notes.

`create-payload-<N>x-<RPS>.json` is the graph from `typical/after-fit/create-payload-<RPS>.json` with `minInstances` / `maxInstances` and the app tier set to N. The 2× files match the after-fit payloads apart from the `name` field. That name does not change the prediction.
