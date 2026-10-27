# SUPERSEDED scenario: 32,764 cap, first errno 1461 in the 1100 rung

**Status: superseded. Not part of any verdict. No campaign ran under it, and it has no outcomes.** It is archived so that the live scenario (`typical-dbsat-pscap23k-2x-v1`, cap 23,552) cannot be silently swapped for it, or the reverse. **Switching between the two scenarios after any outcome of either has been seen is banned.** No `typical-dbsat-pscap32k-*` ID exists in the adapter.

- Cap: `max_prepared_stmt_count = 32764` (not a value in the fit data). Model and parameters: the same trajectory candidate as the live scenario, unchanged.
- Prediction made by the first, never-pushed iteration of this PR: with the formula evaluated on a contiguous schedule (rungs back to back, 1,200 s each) the predicted crossing is in the **1100 RPS rung**, 735 s in (ladder elapsed 5,535 s). Recomputed on 2026-10-27 with the committed `predict.mjs` as `predictCrossing(contiguous 7-rung schedule, 32764)`.
- Why it was dropped: the 1100 rung has never been reached in a 2× rep (the earliest historical breaches stopped the ladder in the 700 or 900 rung), so the scenario was likely to end NOT DECIDED. With the realized gap patterns of the four historical 2× reps, the formula's modeled count at the end of the 900 rung is 24,698 to 32,664, which is 100 to 8,066 below 32,764.
