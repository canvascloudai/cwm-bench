# Typical campaign results

Campaign `typical-v1-20260927c`, one attempt per key, region us-east-2, adapter 1.3.0. The app booted from measurement commit `6aa574d7ff9d3080b88b221bcd59f7d218ae37f0`. Both app nodes reported that git SHA, profile `typical`, and 2 workers.

The before-fit numbers below were checked against the collect JSON in `typical/campaign/typical-v1-20260927c/` and against `typical/PREDICTIONS.md`. Reproduce those scores with `python3 typical/score.py`. Exact floats are in `typical/scores.json` and `holdout/exports/typical-v1-20260927c.summary.md`. The last section is the after-fit result. Its numbers come only from `typical/scores-after-fit.json`.

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
