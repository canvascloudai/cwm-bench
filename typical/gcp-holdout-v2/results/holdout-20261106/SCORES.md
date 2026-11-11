# gcp-holdout-v2 scoring

Archive `gcp-holdout-v2-redacted-20261107T005636Z.tar.gz`: 5 raw split parts verified against `PARTS-MANIFEST.txt`, reassembled, whole-archive SHA-256 verified (`69522cc39070b0fb80b6406e6c28ea189000633c838102b370190041d478adf2`). All 639 entries of the archive's internal `FILES.sha256` verify. Scored against `typical/gcp-holdout-v2/PREREGISTRATION.md` at measurement pin `409bf88943758c920825b59f1027884e7ec74460` (merge of PR #61, adapter **1.7.5**). Frozen predictions and engine hashes were not edited.

Reps scored (no pooling, no rung retries, no replacements):
- r1 = `gcp-holdout-v2-r1-20261106`; generator `us-central1-c`; apps `us-central1-b` + `us-central1-c`
- r2 = `gcp-holdout-v2-r2-20261106`; generator `us-central1-c`; apps `us-central1-b` + `us-central1-f`

Campaign operations summary: 2 applies, 0 whole-apply replacements, 0 rung retries, 0 runner faults, 0 stockouts, 6 rungs collected. Control-transport reconnects: 0 on every rung. Controller SHA-256 `ae5ca2ef225af7ff17f137e2ee51d3690814318207fedcd45e23a4829ff6c8c6` (`scripts/cwm-gcp-holdout-v2.py`); control-transport helper `483dea083cedeff5b20d544b31fe588d9016ad65f487c67c5914eb307fc5b804`. Zone is a covariate and is not scored.

Frozen engine identity (local build, not deployed): engine `1.2.71`; estimator `gcp-fit-v1/ols-midpoint-v2`; evaluator `sha256:74a7876ab75cdb8e1229e9d5a787091e0dfd0096d81ea3014e7a345d4115a434`; receipt `3485481885eddace7ffca8be21f86e67734d573d4294239e7ff98b06b0f64c2e`. Predicted breakpoint **550** RPS (assumed inclusive midpoint of `(500, 600]`).

Method: latency and error rate independently recomputed from raw `k6.json.gz` over each `NNN-steady-window.json` (`recompute.py`; nearest-rank `ceil(p·N)-1`, `start <= t < end`, same rule as gcp-holdout-v1). Cross-check: the same statistics over points tagged `phase=steady` (the `steady_p95.py` selector) differ from the window values by at most 0.65 ms P95 and match the collect-doc P95; no band changes under either selector. Saturation is the prereg binary: steady `http_req_failed` rate **> 1%**. Latency band on `|predicted − measured| / measured`: pass ≤ 20%, marginal > 20% and ≤ 35%, fail > 35%; scored only when error rate ≤ 1%. Per-rep results are primary. All three rungs are labeled **replication** (300/400/500 are fitted loads after the r2 refit).

## Pin, adapter, and health-gate verification

- Every collect has `gitSha` = `terraform.applySha` = `409bf88943758c920825b59f1027884e7ec74460`, the v2 campaign id, and the `gcp-holdout-v2 holdout rung` note. All six adapter `run` outputs report `adapterVersion` `1.7.5`, `ok: true`, `exitCode: 0`.
- Backend-health gate (adapter 1.7.4 behavior, required): `passed` on all six rungs. Every probe in every gate saw `backendCount 2`, `healthyCount 2`, `allHealthy true`, sustained 60 s, no timeout; k6 started ~5 s after `passedAt` each time.

| rep | rung | gate passed (UTC) | k6 start (UTC) | probes | healthy |
|---:|---:|---|---|---:|---|
| r1 | 300 | 2026-11-06 20:42:52.123 | 20:42:57 | 10 | 2/2 every probe |
| r1 | 400 | 2026-11-06 21:05:09.914 | 21:05:15 | 11 | 2/2 every probe |
| r1 | 500 | 2026-11-06 21:27:32.729 | 21:27:37 | 10 | 2/2 every probe |
| r2 | 300 | 2026-11-06 22:11:58.399 | 22:12:03 | 10 | 2/2 every probe |
| r2 | 400 | 2026-11-06 22:34:37.505 | 22:34:43 | 10 | 2/2 every probe |
| r2 | 500 | 2026-11-06 22:57:43.515 | 22:57:48 | 11 | 2/2 every probe |

Both app VMs carried load on every rung (unlike gcp-holdout-v1 r1). Per-node app CPU from the collect:

| rep | rung | app node A % | app node B % | low/high ratio |
|---:|---:|---:|---:|---:|
| r1 | 300 | 27.95 | 28.24 | 0.990 |
| r1 | 400 | 35.07 | 35.26 | 0.995 |
| r1 | 500 | 42.45 | 42.56 | 0.997 |
| r2 | 300 | 25.75 | 25.84 | 0.996 |
| r2 | 400 | 32.47 | 32.05 | 0.987 |
| r2 | 500 | 39.37 | 39.12 | 0.994 |

## Latency (primary, P95)

| rung | label | pred P95 ms | r1 P95 | r1 rel | r1 latency | r2 P95 | r2 rel | r2 latency | mean P95 | mean rel | mean latency |
|---:|---|---:|---:|---:|---|---:|---:|---|---:|---:|---|
| 300 | replication | 68.655 | 77.806 | 11.76% | pass | 70.856 | 3.11% | pass | 74.331 | 7.64% | pass |
| 400 | replication | 86.161 | 95.257 | 9.55% | pass | 91.777 | 6.12% | pass | 93.517 | 7.87% | pass |
| 500 | replication | 103.667 | 130.263 | 20.42% | marginal | 110.113 | 5.85% | pass | 120.188 | 13.75% | pass |

All six measured P95s are slower than predicted (measured exceeds predicted by 3.2% to 25.7% of the prediction). r1 500 is just over the pass line (20.42%).

## Saturation

| rung | pred saturated | r1 err | r1 sat | r1 verdict | r2 err | r2 sat | r2 verdict |
|---:|:---:|---:|:---:|:---:|---:|:---:|:---:|
| 300 | No | 0.0059% | No | hit | 0.0074% | No | hit |
| 400 | No | 0.0386% | No | hit | 0.0369% | No | hit |
| 500 | No | 0.0124% | No | hit | 0.0124% | No | hit |

Breakpoint: no rung saturated on either rep → measured bracket **> 500** on both. Frozen 550 lies in `(500, ∞)` → breakpoint **hit** on r1 and r2. As the prereg states, this ladder cannot distinguish 550 from any other value above 500, so this hit is weak evidence about the onset itself.

Errors were almost entirely HTTP 503 (r2 400 also had one status-0 request). Supporting DB connections vs `max_connections=500`: r1 avg/max 89.1/100, 122.2/133, 278.5/291; r2 68.1/75, 93.0/102, 132.5/152. No rung reached the cap.

## Cost

Every collect has `cost.source=unmeasured`. Every rung: `cost: unscored (billing not final)`. Missing cost is null, not zero.

## Secondary metrics (reported; not band-scored by the prereg; band label informational)

| rep | rung | P50 meas / pred (rel, band) | app CPU/node mean meas / pred (rel, band) | DB CPU meas / pred (rel, band) | DB conns avg meas / pred (rel, band) |
|---:|---:|---|---|---|---|
| r1 | 300 | 11.589 / 11.153 (3.76%, pass) | 28.097 / 26.727 (4.88%, pass) | 45.182 / 42.639 (5.63%, pass) | 89.13 / 74.115 (16.85%, pass) |
| r1 | 400 | 12.062 / 11.362 (5.80%, pass) | 35.165 / 33.626 (4.38%, pass) | 57.321 / 54.902 (4.22%, pass) | 122.21 / 110.287 (9.76%, pass) |
| r1 | 500 | 13.757 / 11.571 (15.89%, pass) | 42.502 / 40.525 (4.65%, pass) | 70.822 / 67.165 (5.16%, pass) | 278.47 / 146.460 (47.40%, fail) |
| r2 | 300 | 11.718 / 11.153 (4.83%, pass) | 25.794 / 26.727 (3.62%, pass) | 39.435 / 42.639 (8.12%, pass) | 68.14 / 74.115 (8.76%, pass) |
| r2 | 400 | 11.526 / 11.362 (1.42%, pass) | 32.261 / 33.626 (4.23%, pass) | 46.407 / 54.902 (18.31%, pass) | 93.00 / 110.287 (18.59%, pass) |
| r2 | 500 | 12.307 / 11.571 (5.98%, pass) | 39.245 / 40.525 (3.26%, pass) | 56.943 / 67.165 (17.95%, pass) | 132.53 / 146.460 (10.51%, pass) |

P99 (reported, not scored): r1 570.8 / 454.8 / 454.6 ms; r2 385.6 / 423.1 / 449.9 ms. Generator CPU (not scored): r1 5.85 / 7.34 / 8.72%; r2 6.02 / 7.48 / 8.85%. App per-node RPS is null in every collect. Achieved RPS was within 0.01% of target on all six rungs.
## Anomalies

1. **Post-workload controller process loss (verified, no effect on scores).** On 2026-11-07 the runner workspace lost its owner processes at 08:22:09 UTC (3:22 AM ET) and recovered at 08:25:32 UTC (3:25 AM ET). This was after both reps' workloads and collects (last steady window ended 2026-11-06 23:17:48 UTC, 6:17 PM ET). The maintenance-recovery record states no workloads replayed, 0 new applies, measurement source and archive unchanged (archive SHA-256 above still matches).
2. **r1 500 DB connections far above prediction (verified).** r1 averaged 278.5 connections (max 291) at 500 RPS against a frozen 146.5 (47.4% over) while r2 averaged 132.5 (max 152). r1 also ran above the connection prediction at 300 (+16.9%) and 400 (+9.8%) while r2 ran below at every rung. r1's two app nodes were balanced (42.45% / 42.56% CPU), so this is not a one-node MIG. It coincides with the only non-pass latency rung (r1 500 P95 130.3 ms, 20.42% marginal). Still well below `max_connections=500`. Secondary metric; not scored.
3. **Cross-rep spread at 500 is large relative to the band basis.** r1 500 P95 130.3 ms vs r2 110.1 ms (an 18% spread). The 20% pass band was set from 3.1% / 1.8% fit-rung spreads in gcp-holdout-v1's prereg. Two reps do not establish run-to-run variability.
4. **Heavy latency tail (reported, not scored).** P99 is 385–571 ms on every rung, i.e. 4–8× P95, on both reps.
5. **DB CPU low on r2 at 400/500.** r2 DB CPU was 18.3% / 18.0% below prediction at 400 / 500 (r1 within 4–6%). Secondary; not scored.
6. **Missing `exit.code` files (packaging gap, verified harmless).** 5 of 6 raw generator run directories lack `exit.code` (only r1 300 has it, value 0). The adapter `run` output (`exitCode: 0`) and the control-transport completion markers (`exitCode: 0`, `reconnects: 0`) record a clean k6 exit on all six rungs.
7. **Cleanup state changed after packaging.** At pack time the operations summary showed paid resources clear on both reps but `allResourcesClear: false` (one Google-held IP address and one network each). The later `cleanup-release-status.json` (created 2026-11-11 00:23 UTC, 2026-11-10 7:23 PM ET; SHA-256 `d136f4799a0b7cd6ff64aeebab0e5a82378d734640b5d8084813d60681fbdacd`) reports `allAttemptResourcesClear: true` for both reps: zero matching resources across 15 types, destroy exit 0, empty Terraform state. Read-only post-release sweeps remain due 2026-11-11 22:36 UTC (5:36 PM ET) and 2026-11-12 00:05 UTC (2026-11-11 7:05 PM ET).
8. **Apply ids unsuffixed and app zones differ by rep (covariate).** Both apply ids are unsuffixed though the generator ran in `us-central1-c`; the prereg permits that. App zones: r1 `b`+`c`, r2 `b`+`f` (gcp-fit-v1 used `b`+`f`). Zone is not scored.

## Redaction check

Own scan over all 640 archive files, decompressing every gzip payload (`redaction_scan.sh`):

- The private project id (full string, supplied at run time, never committed): **0** matches in any file or decompressed payload. A bare numeric fragment of it collides with k6 timestamp/latency digits; every such hit was checked and none is the project id.
- Service-account emails: 0. Any email address: 0. Billing account ids (`XXXXXX-XXXXXX-XXXXXX`) and `billingAccounts/` paths: 0.
- `projects/…` references are only redaction placeholders (`[GCP_PROJECT_ID]`, `[REDACTED_GCP_PROJECT_ID]`, `[CLOUD_ID_…]`) or Google's public image project `rocky-linux-cloud`. `project` / `project_id` fields are `[PRIVATE_FIELD_REDACTED]`.
- Every 10–13 digit run is a fragment of a SHA-256 digest or a hashed `[CLOUD_ID_…]` alias; no project numbers.

The runner's own `PRIVACY-SCAN.json` (0 forbidden matches) agrees.

## Overall (per prereg)

No single combined score (the prereg forbids combining rungs).

- **Latency (primary, per rep):** 5 of 6 rungs **pass**, 1 **marginal** (r1 500, 20.42%). **No fail.** Cross-rep means (both reps scored at every rung): 300 pass (7.64%), 400 pass (7.87%), 500 pass (13.75%).
- **Saturation:** 6 of 6 rung verdicts **hit** (predicted not saturated; measured ≤ 0.04% errors everywhere). Breakpoint `> 500` on both reps → **hit** vs 550, with the caveat that this ladder cannot discriminate the onset.
- **Cost:** unscored (billing not final).

**Verdict: the holdout met the preregistered latency and saturation criteria (5 pass, 1 marginal, 0 fail; 6/6 saturation hits).** This is a fresh-apply **replication** result at fitted loads only. It does not test unseen loads or the assumed 550-RPS onset. Measured P95 ran above prediction on every rung, and r1 500 showed a connection excursion. Activating `CWM_ENABLE_GCP_FIT_V1` or using these results on the accuracy page is a separate decision and was not taken here; the flag remains default OFF and nothing was deployed.
