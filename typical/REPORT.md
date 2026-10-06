# Typical campaign results

Campaign `typical-v1-20260927c`, one attempt per key, region us-east-2, adapter 1.3.0. The app booted from measurement commit `6aa574d7ff9d3080b88b221bcd59f7d218ae37f0`. Both app nodes reported that git SHA, profile `typical`, and 2 workers.

The before-fit numbers below were checked against the collect JSON in `typical/campaign/typical-v1-20260927c/` and against `typical/PREDICTIONS.md`. Reproduce those scores with `python3 typical/score.py`. Exact floats are in `typical/scores.json` and `holdout/exports/typical-v1-20260927c.summary.md`. The after-fit result is the next section. Its numbers come only from `typical/scores-after-fit.json`. The day and region holdouts are the last section. Their numbers come from `typical/scores-holdouts-v1-20261006.json`.

Two earlier setup attempts (`typical-v1-20260927` and `typical-v1-20260927b`) stopped in preflight before Terraform init or apply: one failed on a checkout verification problem and the other on a region comparison bug in the capability check, and neither provisioned a stack or produced measurements. `typical-v1-20260927c` is the only measured campaign, and each scenario key ran once.

## Measured against predicted, before fit

CPU is the mean of the two app servers over the steady window. Latency is the k6 percentile. The ALB steady-window percentile is in brackets. Throughput is whole-run goodput (5 minute warmup plus 15 minute steady). The prediction is a point rate. Error is k6 `http_req_failed` times 100. Measured cost is missing.

| RPS | App CPU % measured / predicted | P50 ms measured [ALB] / predicted | P95 ms measured [ALB] / predicted | P99 ms measured [ALB] / predicted | Throughput measured / predicted | Error % measured / predicted |
| ---: | --- | --- | --- | --- | --- | --- |
| 20 | 1.39 / 4.179 | 5.27 [4.41] / 19 | 8.30 [7.67] / 46 | 76.6 [84.8] / 117 | 17.62 / 20 | 0 (0 of 21,149) / 0.124 |
| 100 | 5.24 / 20 | 4.68 [3.91] / 18 | 8.35 [7.35] / 45 | 83.2 [81.4] / 148 | 87.62 / 100 | 0.0029 (3 of 105,151) / 0.2 |
| 200 | 9.97 / 39.777 | 4.61 [3.86] / 18 | 11.40 [11.68] / 44 | 86.5 [85.5] / 190 | 175.11 / 200 | 0.0062 (13 of 210,150) / 0.247 |
| 300 (holdout) | 15.30 / 59.553 | 4.62 [3.92] / 17 | 26.92 [31.62] / 42 | 97.5 [155.0] / 236 | 262.61 / 299 | 0.0044 (14 of 315,149) / 0.284 |
| 500 (saturation) | 26.34 / 99.107 | 5.19 [4.53] / 15 | 88.19 [91.92] / 39 | 181.9 [201.8] / 341 | 437.58 / 450 | 0.0103 (54 of 525,148) / 9.954 |

Predicted cost is 0.49 / 0.62 / 0.78 / 0.94 / 1.18 USD per hour, including modeled egress. Nothing was measured.

Database CPU was 5.55 / 11.49 / 18.56 / 26.71 / 45.57 %. Predicted database CPU was 1 / 1 / 3.7 / 7.1 / 14.3. Database connections max were 16 / 23 / 36 / 253 / 291, all below the 500 cap. Every failure was unclassified. From 100 RPS up, the ALB 5xx sum was 1 / 7 / 11 / 40. At 20 RPS that series had no datapoints. The target 5xx series had no datapoints on any rung, so a target 5xx count was not measured.

## Holdout score at 300 RPS, before fit: 24.3 / 100

This is the before-fit result: 24.3, and 27.0 without cost. The after-fit result is in the last section.

Each metric scores `max(0, 100 - |predicted - measured| / |measured| x 100)`, rounded to 1 decimal. Error rate scores 100 when the absolute difference is 0.01 percentage points or less. Otherwise it scores the higher of `100 x 0.01 / |difference|` and relative accuracy. When the measured error is 0, relative accuracy is treated as 0, which is the reading in `PREDICTIONS.md` section 4. Weights: P50 0.20, P95 0.25, CPU 0.20, throughput 0.15, error 0.10, cost 0.10.

Measured cost is missing, so the cost score uses the page's list-price reference of USD 0.4545 per hour (ALB 0.0225 + 2 x 0.096 + 0.24, no egress and no generator). That is an assumption, not a bill.

| Metric | Predicted | Measured | Score | Weight | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: |
| P50 | 17 ms | 4.62 ms | 0.0 | 0.20 | 0.0 |
| P95 | 42 ms | 26.92 ms | 44.0 | 0.25 | 11.0 |
| CPU | 59.553 % | 15.30 % | 0.0 | 0.20 | 0.0 |
| Throughput | 299 | 262.61 | 86.1 | 0.15 | 12.9 |
| Error rate | 0.284 % | 0.0044 % | 3.6 | 0.10 | 0.4 |
| Cost | 0.94 | 0.4545 (reference) | 0.0 | 0.10 | 0.0 |
| **Total** | | | | | **24.3** |

Without cost, the other weights rescaled to 1, the total is 27.0. P99 is not weighted: 236 vs 97.5 ms, score 0.

Throughput is scored on whole-run goodput. The ALB steady-window rate at 300 RPS was 233,999 requests over 780 seconds, which is 299.999 requests per second. Scoring throughput on that rate, or on 300, gives a throughput score of 99.7 and a total of 26.3.

## Fit and saturation, before fit, for context

| Rung | P50 | P95 | CPU | Throughput | Error | Cost | Total | Total without cost | P99 (unweighted) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fit-20 | 0.0 | 0.0 | 0.0 | 86.5 | 8.1 | 92.2 | 23.0 | 15.3 | 47.3 |
| fit-100 | 0.0 | 0.0 | 0.0 | 85.9 | 5.1 | 63.6 | 19.8 | 14.9 | 22.0 |
| fit-200 | 0.0 | 0.0 | 0.0 | 85.8 | 4.2 | 28.4 | 16.1 | 14.8 | 0.0 |
| **holdout-300** | 0.0 | 44.0 | 0.0 | 86.1 | 3.6 | 0.0 | **24.3** | 27.0 | 0.0 |
| saturation-500 | 0.0 | 44.2 | 0.0 | 97.2 | 0.1 | 0.0 | 25.6 | 28.5 | 12.6 |

Fit-20 measured error is exactly 0, and the difference from 0.124 is 0.124 percentage points. `PREDICTIONS.md` section 4 scores that case as `100 x 0.01 / 0.124`, which is 8.1. The other stated rule, that a reference of 0 scores 100, would give 100 and a fit-20 total of 32.2 (25.5 without cost). The holdout is not affected: its measured error is not 0.

## Biggest misses, before fit

1. **App CPU is about 3 to 4 times the measurement.** The ratio is 3.0 at 20 RPS and about 3.8 to 4.0 from 100 RPS up. At 300 RPS the engine predicted 59.6 % and the servers ran at 15.3 %. At 500 RPS it predicted 99.1 % and status critical. The servers ran at 26.3 %. CPU scores 0 on every rung.
2. **P50 is about 3 to 4 times the measurement** on the fit and holdout rungs (about 2.9 times at 500 RPS). Predicted 15 to 19 ms. Measured 4.6 to 5.3 ms. P50 scores 0 on every rung.
3. **The latency trend is inverted.** The engine predicted P50 and P95 would fall as load rises. Measured P50 stays near 5 ms. Measured P95 rises from 8.3 ms to 88 ms. P99 also rises.
4. **Pool-saturation errors were predicted and not observed.** The engine predicted 0.12 to 0.28 % error on the required rungs and 9.95 % at 500 RPS, attributed to pool saturation (and, at 500 RPS, CPU overload as well). Measured error was 0.01 % or less. Connections stayed under the 500 cap. No failure was classified as too many connections, queue full, or CPU overload.

Throughput is the only strong weighted metric (scores 86 to 97). Part of the gap is that the prediction is a point rate and the measurement is whole-run goodput.

## Caveats

- Measured cost is missing. The holdout cost score uses the page's list-price reference of USD 0.4545 per hour as an assumption, not a bill.
- Throughput in the 24.3 score is whole-run goodput. Scoring the 300 RPS rung on the steady-window rate instead gives 26.3.
- Fit-20 measured error is exactly 0. Section 4 of `PREDICTIONS.md` scores that as 8.1. The stated rule that a zero reference scores 100 would give 100. This does not affect the holdout.
- The dataset freeze and the 59/20/10/10/1 request mix cannot be verified from the archive. The per-endpoint k6 files were destroyed with the stack, and the optional copies were not made. They follow from the pinned commit, which contains `app-typical/seed/seed-typical.sql` and `load/typical.js`.
- Fifteen minutes after destroy, the tag inventory still listed 15 items: 3 terminated EC2 instances, their 3 root volumes, and 9 security-group rules. The same 15 items were present at the first check. This is likely inventory lag. Terraform reported `Destroy complete! Resources: 43 destroyed.` The plan had added 43. The EC2 check for non-terminated instances was empty, the RDS list was empty, and no RDS snapshot was kept (`skip_final_snapshot` was true).
- `93-destroy-finished-utc.txt` is 2026-09-27T21:51:53Z. That is the end of the inventory recheck. The destroy log in the campaign archive is timestamped 21:36 UTC, which is when destroy itself finished. That log is an operational transcript and is not committed here. The first leftover-check files were captured at that same minute.
- One day, one region, one attempt per rung. There are no repeats.
- The AWS account id is not published. Lean results did not publish it either. It is replaced with `REDACTED` in the committed JSON.

## After owned calibration fit (engine 1.2.5, 2026-09-27)

Without cost, the 300 RPS holdout moves from 27.0 before the fit to 82.4 after it. That is the comparison to use. Before and after cost scores use different bases, so the with-cost totals, 24.3 before and 84.2 or 74.8 after, are not the same kind of number.

CWM production (engine 1.2.5) applies an owned typical calibration built only from the 20, 100, and 200 RPS runs of campaign `typical-v1-20260927c`. The calibration id is `aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0`. The 300 RPS run stayed a holdout and was never used for tuning. The main remaining miss is P95: predicted 12.78 ms, measured 26.92 ms, score 47.5. Displayed table values are rounded. Exact floats are in `typical/scores-after-fit.json` and `typical/after-fit/`.

### Holdout at 300 RPS, after fit

Per-metric scores: P50 90.1, P95 47.5, CPU 96.3, throughput 100.0, error 100.0. Weights are the same as the before-fit section.

Measured cost is still missing. Both cost figures below are references, not a bill.

- **82.4** without cost, on either basis below. Before the fit, the same measurements scored 27.0 without cost.
- **84.2** when the cost prediction excludes data-transfer (egress). The export uses USD 0.4545 per hour, which is the cost breakdown total 0.879919 minus egress 0.425419. The accuracy page shows USD 0.454581 for that field. Both score 100.0 against the USD 0.4545 reference, so the total is 84.2 either way. The weighted cost contribution is 10.0.
- **74.8** when the connector's USD 0.88 per hour is used. That figure includes USD 0.425419 per hour of egress. The cost score is then 6.4, and the weighted contribution is 0.6.

The before-fit cost score compared an egress-inclusive prediction with the no-egress reference, and that score was 0. The after-fit 84.2 drops egress from the prediction. The after-fit 74.8 keeps it. Those are different bases.

| Metric | Predicted | Measured | Score | Weight | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: |
| P50 | 4.165 ms | 4.622 ms | 90.1 | 0.20 | 18.0 |
| P95 | 12.78 ms | 26.92 ms | 47.5 | 0.25 | 11.9 |
| CPU | 14.74 % | 15.30 % | 96.3 | 0.20 | 19.3 |
| Throughput | 262.604 | 262.609 | 100.0 | 0.15 | 15.0 |
| Error rate | 0 % | 0.0044 % | 100.0 | 0.10 | 10.0 |
| Cost, egress excluded | USD 0.4545 (page shows 0.454581) | USD 0.4545 | 100.0 | 0.10 | 10.0 |
| **Total, page** | | | | | **84.2** |
| Cost, connector | USD 0.88 | USD 0.4545 | 6.4 | 0.10 | 0.6 |
| **Total, connector** | | | | | **74.8** |

The page total uses the egress-excluded cost row. The connector total uses the USD 0.88 row instead. P99 is not weighted: predicted 92.48 ms, measured 97.54 ms, score 94.8. P95 remains the main miss in the table above: 12.78 ms predicted against 26.92 ms measured, score 47.5.

### Reproducing this result

Engine 1.2.5. The calibration id is `aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0`. Every create payload pins seed `20240601`. Determinism was confirmed: two runs were identical at every rung, and a seed-7 run gave the same scored outputs. `serviceFamily` is pinned because leaving it out changes the database price, from USD 0.24 per hour to USD 0.12, so the 300 RPS cost becomes USD 0.76 instead of USD 0.88. Reproduce the scores from the frozen files with `python3 typical/after-fit/score_export.py`.

### Predicted against measured

CPU is the app-server mean from the scores file. Latency is the k6 percentile. Throughput is whole-run goodput. Error is percent. Predicted cost on the 20, 100, 200, and 300 RPS rows is the connector figure, which includes egress: 0.48, 0.6, 0.74, and 0.88. At 500 RPS the predicted cost is 1.18.

| RPS | What it is | CPU % measured / predicted | P50 ms measured / predicted | P95 ms measured / predicted | P99 ms measured / predicted | Throughput measured / predicted | Error % measured / predicted |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 20 | fit point | 1.393 / 1.405 | 5.274 / 5.165 | 8.304 / 7.815 | 76.63 / 77.43 | 17.624 / 17.626 | 0 / 0 |
| 100 | fit point | 5.238 / 5.215 | 4.685 / 4.880 | 8.355 / 9.234 | 83.17 / 81.73 | 87.623 / 87.620 | 0.0029 / 0 |
| 200 | fit point | 9.967 / 9.978 | 4.609 / 4.522 | 11.400 / 11.009 | 86.46 / 87.10 | 175.110 / 175.112 | 0.0062 / 0 |
| 300 | holdout | 15.30 / 14.74 | 4.622 / 4.165 | 26.92 / 12.78 | 97.54 / 92.48 | 262.609 / 262.604 | 0.0044 / 0 |
| 500 | outside the fit | 26.34 / 99.107 | 5.188 / 15 | 88.19 / 39 | 181.94 / 341 | 437.58 / 450 | 0.0103 / 9.954 |

Database CPU, measured / predicted, was 5.55 / 5.6, 11.49 / 11.4, 18.56 / 18.6, 26.71 / 25.8, and 45.57 / 14.3.

The 20, 100, and 200 RPS rows are fit points. Close agreement is expected. It is not evidence that the fit works. Their totals are 97.4, 93.3, and 92.5 (97.7, 96.1, and 98.6 without cost). Those totals use the cost scores in the file. A separate page cost basis was supplied only for the 300 RPS holdout.

The 300 RPS row is the real holdout test.

| Rung | P50 | P95 | CPU | Throughput | Error | Cost | Total | Total without cost | P99 (unweighted) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fit-20 | 97.9 | 94.1 | 99.1 | 100.0 | 100.0 | 94.4 | 97.4 | 97.7 | 99.0 |
| fit-100 | 95.8 | 89.5 | 99.6 | 100.0 | 100.0 | 68.0 | 93.3 | 96.1 | 98.3 |
| fit-200 | 98.1 | 96.6 | 99.9 | 100.0 | 100.0 | 37.2 | 92.5 | 98.6 | 99.3 |
| holdout-300, connector cost | 90.1 | 47.5 | 96.3 | 100.0 | 100.0 | 6.4 | 74.8 | 82.4 | 94.8 |
| holdout-300, page cost | 90.1 | 47.5 | 96.3 | 100.0 | 100.0 | 100.0 | 84.2 | 82.4 | 94.8 |
| saturation-500, fit does not apply | 0 | 44.2 | 0 | 97.2 | 0.1 | 0 | 25.6 | 28.5 | 12.6 |

### 500 RPS diagnostic (held out, outside fitted range)

On engine 1.2.5 the owned fit does not apply above 300 RPS. The engine falls back to generic typical and predicts 99.107% CPU, status critical, and 9.954% errors, against measured 26.34% CPU and 0.0103% errors. That is a false saturation warning. The export scores this rung 25.6, or 28.5 without cost. This is a known open gap.

### Weak spots

P95 at 300 RPS is the weak latency score. Predicted 12.78 ms, measured 26.92 ms, score 47.5.

Predicted P50 falls with load: 5.165, 4.880, 4.522, then 4.165 ms. Measured P50 stays about 4.6 ms from 100 RPS through the holdout (4.685, 4.609, and 4.622 ms). At 20 RPS it was 5.274 ms.

## Day and region holdouts (typical-holdouts-v1-20261006)

Campaign `typical-holdouts-v1-20261006`, scored on 2026-10-06 against the frozen after-fit reference at `64c6e89d74e25c549e7dad740471443621da5aac`, under `typical/PREREGISTRATION.md` section 12. Adapter 1.4.0. Both app nodes on each apply reported profile `typical`, 2 workers, and that git SHA. Nothing was refit. Coefficients, `typical/after-fit/score_export.py`, and the calibration id are unchanged. `typical/PREREGISTRATION.md` is unchanged.

Two applies: `typical-later-day-20261006` in us-east-2 (100 RPS, then 300 RPS, on 2026-10-06 UTC) and `typical-second-region-20261006` in us-west-2 (the same order, the same UTC day). Evidence is in `typical/campaign/typical-holdouts-v1-20261006/`. Exact run floats are in `holdout/exports/typical-holdouts-v1-20261006.summary.md`. Deltas and per-metric scores are in `holdout/exports/typical-holdouts-v1-20261006.metrics.csv` and `typical/scores-holdouts-v1-20261006.json`.

### Headline

The 100 RPS rungs repeat the typical-v1 measurement closely. Section 12.1 says that establishes repeatability at 100 RPS only.

At 300 RPS, the published after-fit **84.2** (page cost) / **82.4** (without cost) did not hold. The later day in us-east-2 scored **76.0 / 73.3**. us-west-2 scored **81.1 / 79.0**. The gap is almost entirely P95: **26.92 ms** on the original holdout, **51.12 ms** on the later day, **32.89 ms** in us-west-2, against a prediction of **12.78 ms**. The P95 score falls from 47.5 to 25.0 (east) and 38.9 (west).

Section 12 sets no numeric pass/fail tolerance, and section 9.4 says no composite score is a pass/fail criterion. "Did not hold" is an interpretation of these scores, not a preregistered verdict. On the page basis the composites are 8.2 and 3.1 points below 84.2. Without cost they are 9.1 and 3.4 points below 82.4. Across the three single 300 RPS runs, P95 varied by about 1.9× (26.9 / 51.1 / 32.9 ms).

| 300 RPS rung | Page cost (no egress) | Without cost | Connector cost (0.88) |
| --- | ---: | ---: | ---: |
| Original `typical-holdout-300` (published; reproduced below) | 84.2 | 82.4 | 74.8 |
| `typical-later-day-300` (us-east-2, 2026-10-06 UTC) | 76.0 | 73.3 | 66.6 |
| `typical-second-region-300` (us-west-2, 2026-10-06 UTC) | 81.1 | 79.0 | 71.7 |

App CPU at 300 RPS was 15.81% (east) and 16.09% (west), against 15.30% originally and 14.74% predicted. The CPU score went from 96.3 to 93.2 / 91.6. P50 scored 80.5 in the east (5.18 ms measured, 4.17 ms predicted) and 90.1 in the west. Throughput and error scored 100.0 on every new rung.

At 100 RPS, goodput matched the fit-100 row to within 0.003 RPS. App CPU was +0.22 points in the east and +0.49 points in the west. P99 was about +5 to +6 ms in both. Error counts were 0 (east) and 3 (west), against 3 in the reference. k6 P50/P95 were about 16 to 17% higher on the later day and 3 to 9% lower in us-west-2. DB CPU was higher in both (+17.2% east, +9.8% west). Page-style scores against the after-fit 100 RPS prediction are 95.6 / 95.1 without cost (east) and 91.4 / 90.5 (west). The fit-rung reference in `typical/scores-after-fit.json` is 93.3 / 96.1 without cost. Those fit-rung numbers are the fit rung, not a prediction of these scores.

### Reproduction check

`python3 typical/after-fit/score_export.py` was run unmodified, with the frozen inputs in `typical/after-fit/`. It reproduces the published 300 RPS after-fit result:

```
300 RPS independent holdout, after fit (engine 1.2.5):
  no-egress cost basis (0.4545 USD/hour):  total 84.2
  connector cost basis (0.88 USD/hour):    total 74.8
  without cost (either basis):             82.4
  matches expected 84.2 / 74.8 / 82.4: True
```

All five rungs (20/100/200/300/500) match `typical/scores-after-fit.json` and `typical/after-fit/scores-reproduced.json`: totals, no-cost totals, per-metric scores, and P99 scores. The scored write-up reached the same 84.2 / 82.4 / 74.8 from `typical/after-fit/measured-values.json` and from values transcribed out of the typical-v1 collect JSON. Reproduced: yes.

Scoring is the method in the before-fit section and in `score_export.py`. Per metric, `max(0, 100 - |predicted - measured| / |measured| x 100)`, rounded to 1 decimal before weighting. Weights are unchanged. Without cost, the non-cost weighted sum is divided by 0.9. Measured cost is still missing. The cost reference is USD 0.4545 per hour (list price, no egress), not a bill.

### Validity

All four rungs meet the preregistered validity rules. No generator-CPU discard applies. Collects are complete. There were no load retries.

| Check | east 100 | east 300 | west 100 | west 300 |
| --- | --- | --- | --- | --- |
| Adapter | 1.4.0 (run JSON lost; recovered envelope, wait-ready, and collect are 1.4.0) | 1.4.0 | 1.4.0 | 1.4.0 |
| Profile / workers / SHA | typical / 2 / 64c6e89 | same apply and instance ids as east 100 | typical / 2 / 64c6e89 | same apply and instance ids as west 100 |
| Region | us-east-2 | us-east-2 | us-west-2 | us-west-2 |
| UTC day | 2026-10-06, after 2026-09-27 | `calendarDateUtc` 2026-10-06, fit date 2026-09-27 | 2026-10-06 | 2026-10-06 |
| Generator CPU avg / peak | 1.90 / 2.00 | 4.82 / 4.99 | 2.01 / 2.10 | 4.91 / 5.01 |
| Collect ok / complete / missing / invented / knownGap | true / true / [] / false / false | same | same | same |
| k6 iterations (scheduled 105,151 / 315,149) | 105,151 | 315,097 (52 short); steady VU cap 400 → 423 | 105,149 (2 short) | 315,149 |
| k6 failures, all unclassified | 0 | 21 | 3 | 12 |
| ALB ELB 5xx / target 5xx | none (no datapoints) / unmeasured | 17 / unmeasured | 3 / unmeasured | 1 / unmeasured |
| Attempts | 1, recovered after a workspace restart, not rerun | 1 | 1 | 1 |

Reference rows: fit-100 generator CPU 1.97 / 2.08, ALB 5xx 1, 3 failures; holdout-300 generator CPU 4.92 / 5.02, ALB 5xx 11, 14 failures. Target 5xx was unmeasured in typical-v1 as well. The new 5xx and failure counts are the same order of magnitude.

### Measured minus the typical-v1 reference

Delta is holdout minus the measured typical-v1 row (section 12.4). Displayed cells are the scored write-up's rounding. Exact floats are in the export summary and the metrics CSV.

| Metric | typical-fit-100 | later-day (us-east-2) | second-region (us-west-2) |
| --- | ---: | ---: | ---: |
| App CPU % | 5.238 | 5.462 (+0.223) | 5.725 (+0.487) |
| DB CPU % | 11.492 | 13.474 (+1.982) | 12.614 (+1.122) |
| DB connections max | 23 | 25 (+2) | 22 (−1) |
| k6 P50 ms | 4.685 | 5.440 (+0.755) | 4.531 (−0.153) |
| k6 P95 ms | 8.355 | 9.790 (+1.435) | 7.630 (−0.725) |
| k6 P99 ms | 83.17 | 88.76 (+5.59) | 88.17 (+5.00) |
| Goodput RPS | 87.623 | 87.625 (+0.003) | 87.622 (−0.001) |
| k6 failed / requests | 3 / 105,151 | 0 / 105,151 | 3 / 105,149 |

| Metric | typical-holdout-300 | later-day-300 (us-east-2) | second-region-300 (us-west-2) |
| --- | ---: | ---: | ---: |
| App CPU % | 15.303 | 15.814 (+0.510) | 16.085 (+0.782) |
| DB CPU % | 26.710 | 31.418 (+4.709) | 29.270 (+2.560) |
| DB connections max | 253 | 428 (+175) | 348 (+95) |
| k6 P50 ms | 4.622 | 5.175 (+0.554) | 4.622 (−0.000) |
| k6 P95 ms | 26.918 | 51.122 (+24.205) | 32.887 (+5.969) |
| k6 P99 ms | 97.54 | 126.41 (+28.87) | 112.82 (+15.28) |
| Goodput RPS | 262.609 | 262.552 (−0.057) | 262.612 (+0.004) |
| k6 failed / requests | 14 / 315,149 | 21 / 315,097 | 12 / 315,149 |

At 300 RPS, CPU, goodput, west P50, and the error rate repeat. The tail does not. k6 P95 was +24.2 ms (+89.9%) in the east and +6.0 ms (+22.2%) in the west. ALB P95 was +121% / +20%. P99 was +29.6% / +15.7%. West DB connections average was 146.5 against 221.1 on the original, while the max rose from 253 to 348.

Lean later-day / us-west-2 deltas at 100 RPS were −0.22 / −0.33 CPU points and +0.86 / +1.79 ms P99. Section 12.5 says those are context only.

### Page-style scores against the after-fit predictions

Predictions are the engine 1.2.5 owned-fit outputs already in `typical/scores-after-fit.json` (100: cpu 5.215, p50 4.879573, p95 9.234496, p99 81.72693, thr 87.619644, err 0, cost 0.6; 300: cpu 14.74, p50 4.1652207, p95 12.783974, p99 92.47731, thr 262.604, err 0, cost 0.88).

| Rung | Basis | P50 | P95 | CPU | Throughput | Error | Cost | Total | Without cost | P99 (unweighted) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| later-day (us-east-2, 100) | page (no-egress) 0.4545, derived | 89.7 | 94.3 | 95.5 | 100.0 | 100.0 | 100.0 | 95.6 | 95.1 | 92.1 |
| later-day (us-east-2, 100) | connector 0.6 | 89.7 | 94.3 | 95.5 | 100.0 | 100.0 | 68.0 | 92.4 | 95.1 | 92.1 |
| second-region (us-west-2, 100) | page (no-egress) 0.4545, derived | 92.3 | 79.0 | 91.1 | 100.0 | 100.0 | 100.0 | 91.4 | 90.5 | 92.7 |
| second-region (us-west-2, 100) | connector 0.6 | 92.3 | 79.0 | 91.1 | 100.0 | 100.0 | 68.0 | 88.2 | 90.5 | 92.7 |
| later-day-300 (us-east-2) | page (no-egress) 0.4545 | 80.5 | 25.0 | 93.2 | 100.0 | 100.0 | 100.0 | 76.0 | 73.3 | 73.2 |
| later-day-300 (us-east-2) | connector 0.88 | 80.5 | 25.0 | 93.2 | 100.0 | 100.0 | 6.4 | 66.6 | 73.3 | 73.2 |
| second-region-300 (us-west-2) | page (no-egress) 0.4545 | 90.1 | 38.9 | 91.6 | 100.0 | 100.0 | 100.0 | 81.1 | 79.0 | 82.0 |
| second-region-300 (us-west-2) | connector 0.88 | 90.1 | 38.9 | 91.6 | 100.0 | 100.0 | 6.4 | 71.7 | 79.0 | 82.0 |
| fit-100 (published fit rung) | connector 0.6 | 95.8 | 89.5 | 99.6 | 100.0 | 100.0 | 68.0 | 93.3 | 96.1 | 98.3 |
| holdout-300 original | page 0.4545 | 90.1 | 47.5 | 96.3 | 100.0 | 100.0 | 100.0 | 84.2 | 82.4 | 94.8 |
| holdout-300 original | connector 0.88 | 90.1 | 47.5 | 96.3 | 100.0 | 100.0 | 6.4 | 74.8 | 82.4 | 94.8 |

The 100 RPS rows test repeatability at 100 only. The 300 RPS rows are the test of whether 84.2 / 82.4 holds. On this evidence the after-fit 300 RPS composite falls between about 76 and 84 on the page basis, or 73 and 82 without cost. The known P95 miss (predicted 12.78 ms, original measured 26.92 ms, score 47.5) stays unresolved, and it is larger on the later day.

### One-minute DB connection step on every 300 RPS run

Every 300 RPS run, including the original, has one CloudWatch minute where DB connections step up and ALB tail latency spikes. Section 10 excludes nothing. This is descriptive.

- Original, 21:00Z: connections 53 → 252, ALB p99 900 ms. Other minutes' ALB p95 were 14 to 41 ms.
- East, 03:00Z: connections 65 → 427, ALB p95 314 ms, ALB p99 1,897 ms, 17,945 requests in that minute. Connections then stayed at 427 (steady-window max 428). Per-minute ALB p95 for the rest of the window stayed at 49 to 65 ms. The 52 missing iterations and the VU cap rising to 423 line up with this stall.
- West, 04:00Z: connections 74 → 297, then 348 at 04:01Z, ALB p99 1,361 ms.

### Recovered east 100 attempt

A workspace restart lost the local runner and its buffered run JSON during `typical-later-day`. The detached k6 run on the generator was reattached, not rerun. Remote identity (campaign, run id, scenario) matched. The collect is the raw adapter output (`identityMatches: true`). `run-recovered.json` is an explicitly labeled envelope, not adapter `run` output.

During steady state (02:41–02:49Z) the reattach sent 5 SSM commands to the generator: an identity read, three 4-minute polling loops, and a teardown after completion. Generator CPU stayed at 1.90%, against 1.97% on fit-100. The scored write-up treats that as no visible load effect.

The detection timestamps disagree: 02:34:53Z in `README-execution.md` and `workspace-recovery-note.md`, 02:36:45.986Z in `recovery-1791254205986/workspace-interruption.json`, and 02:40:57.478Z in `reattach-typical-later-day-1791254457478/interruption.json`. Steady state began at 02:34:21Z.

### Cost

Measured cost is missing on every rung. Both cost figures are references, not a bill.

- **Page basis (no egress) at 300 RPS** is the published one: prediction USD 0.4545 per hour, the same basis as the 84.2.
- **Page basis at 100 RPS is derived.** `typical/scores-after-fit.json` publishes no page basis at 100. The 0.4545 used here is the non-egress `costBreakdown` lines in `typical/after-fit/raw/rung100-runA-metrics.json` (0.096 + 0.096 + 0.24 + 0.0225), excluding egress 0.141944. It is not a published figure. `costPredDerived` is true on the 100 RPS page-basis objects in the scores file.
- **Connector basis** is 0.6 at 100 RPS and 0.88 at 300 RPS, from `costPerHour` in those same metric files. That is the basis behind the published fit-100 total of 93.3.
- **us-west-2 uses the us-east-2 prediction and the USD 0.4545 reference.** Section 12.4 says to score it the same way. The west cost component is not a regional cost test. The without-cost totals do not use it.

### Other conditions

- **Newer AMI.** The resolved AL2023 image is `ami-0d3d85815a9746bc5` in us-east-2 and `ami-0d53cc9bd365ad65b` in us-west-2, against `ami-08be4b1b8afa29958` on typical-v1. A later-day run also picks up a newer OS image.
- **Shorter ladder before 300.** Each holdout 300 rung ran after only the 100 rung, on a freshly seeded database. The original 300 ran after 20 / 100 / 200, so this campaign had fewer prior comment inserts (section 7.3).
- **Failed setup, kept.** Two pre-apply stops, at 02:15:54Z and 02:19:13Z, both ended with `Regional backend is not explicitly empty`. No apply and no load. The third east preparation is the measured one.
- **Cleanup.** Destroy finished at 03:14:22Z (east) and 04:10:51Z (west). Both Terraform states are empty, and direct checks found no live instances, volumes, rules, or RDS. The strict tag inventory still listed 14 ARNs in the east and 16 in the west at 04:26Z. Each was classified `terminated` (3 per region) or `not-found` (east 15 including earlier subnets, west 13). The runner exited 1 and its strict safety lock is retained. Same tag-lag pattern as typical-v1.
- **`artifacts.files` listing.** Every new collect contains stray `}`, `},`, `]` and `],` entries (44 to 48 per file) beside the 8 real file names. The same junk is in the typical-v1 1.3.0 collects. Summary and identity are present, and k6 counters are consistent.
- **Capability `primaryRegion`.** The capability document says `us-east-1`. The typical keys enforced us-east-2 and us-west-2 as section 12 requires.

