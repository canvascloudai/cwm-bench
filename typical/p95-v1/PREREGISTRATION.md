# cwm-bench `typical-p95-v1`: P95 model validation holdout (1× / 2× / 3× m5.large, reverse ladder), pre-registration

Status: **FINAL.** Predictions are frozen for the candidate model. The engine baseline is frozen (1.2.18). `measurement_sha` is the merge commit of the adapter 1.6.1 provenance fix on main, not `68b5fa2`. Nothing applied on AWS, nothing filed in Replit. Written 2026-10-10. Owner: Kevin Brown.
Adapter 1.6.1 provenance fix before any apply; predictions and criteria unchanged.
Rev 2 applies an external review: adds 1×, splits the result into two verdicts that are reported separately, renames the bands as acceptance tolerances, fixes the scoring window, freezes the invalidation and budget rules, and corrects the criterion-(c) wording.
The candidate model in `predictions/` and the engine baseline in `predictions/engine-baseline/` stay frozen. `measurement_sha` is the merge commit of the adapter 1.6.1 provenance fix on main, not `68b5fa2`. After that commit, any change to §2–§8 means a new campaign version (`typical-p95-v2`).

Labels: **[FACT]** in the repo or a saved artifact, cited inline · **[DECISION]** a choice for this campaign · **[ASSUMPTION]** an unverified premise · **[DERIVED]** arithmetic, shown.

---

## 0. Summary

Test a **candidate two-input P95 model** (per-node RPS + total RPS) out of sample. Measure the frozen typical-v1 workload on **1×, 2× and 3× m5.large** at 300, 200 and 100 total RPS. Run the **ladder in reverse (300 → 200 → 100)** on a **fresh seed**, with **3 independent applies per config: 9 applies, 27 rungs**, spread over **3 UTC days in a Latin square**. Before any apply, freeze two predictors: (1) the candidate model, computed by a committed deterministic script from a committed params file; (2) the live CWM engine, frozen through MCP with its returned version recorded, as the baseline. Judge on the **median of 3 reps per cell**. Report **two separate verdicts**: **absolute P95** (§7.3) and **server change** (§7.4). Neither verdict implies the other. **No refitting from this campaign.**

## 1. Questions

- Q1. **Absolute P95, out of sample.** Is each cell's median P95 inside its acceptance tolerance on runs the model never saw, with a ladder order it was never fitted on?
- Q2. **Beats the engine** at every 300 RPS cell, where the engine missed by 2–5× in typical-scale-v1?
- Q3. **Server change.** Does the model get the direction and size of the P95 change for 2→1 and 2→3 servers at each rung? This is the question behind "the scaling limitation is resolved".
- Q4. **Mechanism (descriptive, not scored).** Using per-minute k6/ALB percentiles, plus pool wait and event-loop lag if they are added, where does the 300 RPS tail come from?

## 2. Fixed topology [FACT unless marked]

Same as typical-scale-v1 §2: us-east-2; app = m5.large with the pinned AMI, Node CRUD service, 2 workers/node, adapter 1.6.0 (scale-v1 collects stay on 1.5.0); per-node mysql2 pool 250; DB = db.r5.large, MySQL 8.0 (`max_connections` 500); internal ALB; k6 generator as in scale-v1; frozen typical-v1 mix; **5 min warmup ramp + 15 min steady** (`load/lib/common.js` `DEFAULT_WARMUP='5m'`, `DEFAULT_DURATION='15m'`). Only two things vary: app server count (1, 2, 3) and total RPS (300, 200, 100).
- [ASSUMPTION] RDS resolves to `8.0.46-rds.20260908` (Extended Support). The version is recorded per apply and not pinned.

## 3. Configuration, rung matrix and schedule

| Config | Rungs (in order) | Per-node RPS |
|---|---|---|
| 1× m5.large | 300 → 200 → 100 | **300** → 200 → 100 |
| 2× m5.large | 300 → 200 → 100 | 150 → 100 → 50 |
| 3× m5.large | 300 → 200 → 100 | 100 → 66.7 → 33.3 |

- [DECISION] **Fresh seed per apply.** Each apply gets a new stack and the standard seed, with nothing carried over. The 300 rung therefore runs first, on the smallest table and a cold cache. This is intended: all fit data ran 300 last.
- [DECISION] **3 reps = 3 separate applies per config**, for 9 applies in total.
- [DECISION] **Latin square over 3 UTC days.** Each config runs once per day and once in each daily slot:

| Slot | Day A | Day B | Day C |
|---|---|---|---|
| 1 | 1×-r1 | 2×-r2 | 3×-r3 |
| 2 | 2×-r1 | 3×-r2 | 1×-r3 |
| 3 | 3×-r1 | 1×-r2 | 2×-r3 |

  That is about 3 × 76 min ≈ 3.8 h per day. A replacement apply (§7.7) goes at the end of the same day if time allows, otherwise first on the next day. A fourth day is allowed only for replacements.
- [DECISION] **New keys only.** Test IDs: `typical-p95-{1x|2x|3x}-r{1..3}-YYYYMMDD`, with a letter suffix for replacements (e.g. `r1a`). Rung keys: `typical-p95-{1x|2x|3x}-{300|200|100}`. No `typical-fit-*`, `typical-holdout-*` or `typical-scale-*` key may be reused.
- [DECISION] **1× edge.** At 1×-300 the node carries 300 RPS, which is exactly the model's `pn_max = 300`. That is the edge of its per-node range. Above 300 it switches to an untested linear-tangent extrapolation, and that branch is **not** exercised here: 300/node evaluates the exponential form. The only training data at 300/node is typical-scale-v1 1×-300 (3 runs, 88.8–96.6 ms), so this cell tests the model where it is least constrained: a single training cell sits at the boundary, and the fresh-seed, cold-start conditions there are new. The cell is scored like the others. A miss there means the model fails at its edge, nothing more. A pass says nothing about behavior above 300/node.

## 4. Metrics and scored measurement window

### 4.1 Scored P95: definition [FACT, checked in `canvascloudai/cwm-bench` @ local clone `3b6708c`]

**Scored P95 = k6 `http_req_duration` p(95) over every request in the rung's k6 run: the 5-min warmup ramp plus the 15-min steady window.** This is the same definition as in all training data. Evidence:
- `scripts/lib/adapter/assemble.mjs` `parseK6Summary` reads `p95Ms` from `pickK6Metric(metrics,'http_req_duration')`. That function returns the `{phase:steady}` sub-metric **if one exists**, otherwise the untagged aggregate (`assemble.mjs:22-28`).
- `load/typical.js` defines **no thresholds**, so k6 creates no `http_req_duration{phase:steady}` sub-metric. The aggregate, which includes the `warmup` scenario's requests, is what gets used. (Error classes are steady-scoped, `assemble.mjs` `steadyErrorEntries`. Latency is not.)
- Request counts confirm it: fit-day 20 RPS has 21,149 requests ≈ 20 × (150 ramp-equivalent s + 900 s) = 21,000; scale-v1 1×-300 r1 has 315,150 ≈ 300 × 1,050. A steady-only count would be 270,000. The scale-v1 runbook's "goodput (whole-run, the basis of the existing scores)" agrees.
- Model training (`out/typical-p95-runs.csv` `k6_p95`) and `typical/after-fit/score_export.py` (`M['p95Ms']`) both use this collect value.

Rev 1 contradicted itself: §4 said "whole-rung" and §10 said "warm-up minute excluded". **"Warm-up excluded" was wrong.** No warm-up exclusion applies to scored P95. The ramp is roughly 14% of a rung's requests (≈ 45k of 315k at 300 RPS).
- [DECISION] Keep this definition unchanged, so the holdout matches the training data. The adapter must not add a k6 threshold or any other change that creates a `phase:steady` latency sub-metric: that would silently switch `pickK6Metric` to steady-only. The §5.4 dry run asserts that the collect's `latency.p95Ms` equals the untagged aggregate.
- Descriptive only, never scored: **steady-only P95, computed from the request-level k6 samples whose timestamps fall in the 15-minute steady window** (requires the k6 JSON/CSV raw output, not only the summary). Per-minute P95s are **never averaged** to stand in for a percentile; they are used only to show the tail shape over time, including any cold-start transient on the first (300) rung.

### 4.2 Other metrics

| Metric | Granularity | Status |
|---|---|---|
| k6 p50/p95/p99 | whole rung (scored, §4.1) **and per minute** | per-minute export required (adapter change, §9) |
| ALB TargetResponseTime p95/p99 | per minute (CloudWatch) | required |
| DB connections avg/max, DB CPU, app CPU per host | per minute | required |
| Generator CPU | steady window | required (invalidation, §7.7) |
| Event-loop lag p99, mysql2 pool wait | per minute | optional, if cheap (D7) |
| RDS engine version string | per apply | required |
| Errors by class, goodput, `http_req_failed` | per rung | required |

## 5. Prediction freeze and evidence package (before any apply)

### 5.1 Predictor 1: candidate model [FACT: `typical/p95-v1/predictions/`]

```
pn = total / servers;  Tc = min(total, 300)
core = exp(a + b·pn/100 + c·Tc/100)      (pn ≤ 300; above 300 linear along the tangent; untested, not exercised)
P95  = max(8 ms, P50, core)
a = 1.0576059, b = 0.7560509, c = 0.4474054   (recommended-params.json)
```
At freeze, the P50 input is 0. P50 never binds in these cells; the 8 ms floor binds at 2×-100 and 3×-100.

### 5.2 Predictor 2: live CWM engine (baseline)
Use the same MCP freeze as scale-v1 §5.1, for **all 9** config × rung cells. Record the request and response JSON, `calibrationEvidence.kind`, the calibration id and the **engine version exactly as returned** (1.2.17 expected; do not assume 1.2.14).

### 5.3 Frozen prediction table (draft values) [DERIVED: `predict_p95.py` → `model-predictions.csv`]

Acceptance tolerance = central × [0.666, 1.432] (§7.2).

| Cell | Per-node RPS | Model central (ms) | Acceptance tolerance (ms) | Engine 1.2.14 ref (ms) | scale-v1 median (ms; warm, forward ladder; training data) |
|---|---:|---:|---|---:|---:|
| 1×-300 | **300 (edge)** | **106.48** | 70.92 – 152.48 | 18.1 | 95.0 |
| 1×-200 | 200 | **31.96** | 21.29 – 45.77 | 14.6 | 37.5 |
| 1×-100 | 100 | **9.59** | 6.39 – 13.73 | 11.0 | 9.1 |
| 2×-300 | 150 | **34.26** | 22.82 – 49.06 | 12.78 | 41.3 |
| 2×-200 | 100 | **15.01** | 10.00 – 21.49 | 11.01 | 15.1 |
| 2×-100 | 50 | **8.00** (floor) | 5.33 – 11.46 | 9.23 | 8.4 |
| 3×-300 | 100 | **23.47** | 15.63 – 33.61 | 11.01 | 20.7 |
| 3×-200 | 66.7 | **11.66** | 7.77 – 16.70 | 9.83 | 12.1 |
| 3×-100 | 33.3 | **8.00** (floor) | 5.33 – 11.46 | 8.64 | 8.7 |

The 1.2.14 engine values are for reference only. The frozen baseline is whatever §5.2 returns.

Predicted server-change ratios, R = P95(fewer servers) / P95(more servers):

| Rung | 2→1: R = P(1×)/P(2×) | 2→3: R = P(2×)/P(3×) |
|---|---:|---:|
| 300 | 106.48/34.26 = **3.108** | 34.26/23.47 = **1.460** |
| 200 | 31.96/15.01 = **2.129** | 15.01/11.66 = **1.287** |
| 100 | 9.59/8.00 = **1.199** | 8.00/8.00 = **1.000** |

### 5.4 Evidence package: one commit before the first apply; its SHA is `measurement_sha` [DECISION]
All in `typical/p95-v1/` in `canvascloudai/cwm-bench`:
1. **Predictor 1:** `predictions/recommended-params.json` (byte-identical to the model folder copy, sha256 recorded), `predict_p95.py` (stdlib only, no fitting) and its output `predictions/model-predictions.csv`.
2. **Predictor 2:** `predictions/engine-baseline/predictions.json` (engine 1.2.18, nine `latencyP95` centrals), `FROZEN.md`, `call-log.json` (simulation ids), `payloads/` (exact create request bodies), and `raw/` (harvested response fields per cell). Full raw response bodies were not saved as separate files. See `predictions/engine-baseline/README.md`.
3. **Instrumentation choices:** k6 per-minute export format; whether event-loop lag and pool wait are on (D7) and how they are sampled; the ladder parameter `[300,200,100]`; warmup 5m / steady 15m; a note that k6 has no thresholds (§4.1).
4. **Scoring code:** `score_p95_v1.py` (medians, tolerance check, page scores, criteria a/b/c, server-change criteria, invalidation checks), with this prereg's numbers as constants. It is tested on scale-v1 data, and the test must reproduce the §5.3 scale-v1 medians.
5. **This prereg** (frozen copy), `simulate_pass_rates.py`, and the decisions table (§12) as approved.
6. **Dry-run evidence** (no AWS: local k6 against a stub): the per-minute export is present, and `latency.p95Ms` comes from the untagged aggregate.

`measurement_sha` is the merge commit of the adapter 1.6.1 provenance fix on main, not `68b5fa2`. Every apply uses `app_source_git_ref = measurement_sha`. Predictions and criteria are unchanged. Nothing in the package changes after that commit.

## 6. Frozen claims

- **Absolute verdict:** A-a, A-b, A-c (§7.3).
- **Server-change verdict:** S-300 and S-other (§7.4).
- Descriptive only: per-minute tail shape, pool wait, event-loop lag, DB connections, RDS version, steady-only P95, and a reverse-vs-forward ladder comparison against scale-v1.

## 7. Scoring and verdicts

### 7.1 Page score (unchanged) [FACT]
`score = 100 − 100·|measured − predicted| / measured`. Example: 2×-300 in scale-v1 gives 100 − 100·|41.31−34.26|/41.31 = 82.9.

### 7.2 Acceptance tolerances [DERIVED from `out/typical-p95-runs.csv`, `model/recommended-params.json`]

**These are acceptance tolerances, not established 10–90% predictive intervals.** They come from the model's leave-one-campaign-out (LOCO) residual quantiles, widened for median-of-3 noise:
- LOCO single-run residual band (log): 10% = ln 0.708 = −0.345; 90% = ln 1.334 = +0.288. σ_cv (RMSE log) = 0.2375.
- Rep-to-rep σ_r of ln P95 = **0.25**: the pooled 300 RPS 2×/3× value of 0.230, rounded up. The median of 3 has SD 0.670·σ_r = 0.168, and its 10/90 quantile is 1.2816 × 0.168 = 0.215.
- low = −√(0.345² + 0.215²) = −0.406 → **×0.666**; high = +√(0.288² + 0.215²) = +0.359 → **×1.432**.
- **Noise is partly double-counted on purpose.** The LOCO residuals already contain single-run noise, so adding median noise on top makes the tolerances wider than a calibrated interval. This is a deliberate, conservative choice. Separated out, the structural model error is σ_s = √(0.2375² − 0.2175²) = 0.095.
- The same multipliers apply to all 9 cells, including the 1× cells. For comparison, scale-v1 1× rep SDs were 0.101 / 0.208 / 0.045 at 100/200/300, all at or below σ_r = 0.25.

### 7.3 Verdict 1: Absolute P95 validation (A-a, A-b, A-c all required)
- **A-a:** cell median inside its tolerance in **≥ 8 of 9 cells**, and **in all three 300 RPS cells** (1×, 2×, 3×).
- **A-b:** the **median** candidate page score across the 9 cells is **≥ 80**.
- **A-c:** the candidate page score is above the frozen engine's page score in **all three 300 RPS cells**.

### 7.4 Verdict 2: Server-change validation (S-300 and S-other both required)
For each rung t ∈ {300, 200, 100} and each transition (2→1: R = med(1×)/med(2×); 2→3: R = med(2×)/med(3×)), a transition **passes** if:
1. **Size:** |ln(R_measured / R_predicted)| ≤ ln(tol_t), and
2. **Direction:** R_measured > 1. This applies only where R_predicted ≥ 1.25: all of 300, plus 200 for both transitions. At 100 the predicted change (1.20 and 1.00) is below the noise, so only size is checked there.

**Tolerance derivation [DERIVED]** (log scale; the ratio of two medians):
- Noise of each median: 0.670 × σ_r. At 200/300 that is 0.670 × 0.25 = 0.168; at 100 it is 0.670 × 0.093 = 0.062 (σ_r at 100 RPS = pooled 0.093).
- A ratio of two independent medians: √2 × 0.168 = **0.237** (200/300); √2 × 0.062 = **0.088** (100).
- Structural error on the ratio, if cell errors are independent: √2 × σ_s = √2 × 0.095 = 0.134. This is conservative: correlated cell errors (a whole-campaign shift) cancel in a ratio.
- Total SD: 200/300: √(0.237² + 0.134²) = **0.272**; 100: √(0.088² + 0.134²) = **0.160**.
- Two-sided 90% (z = 1.645): 200/300: 0.448 → ×/÷1.565, **rounded to ×/÷1.6** (ln 1.6 = 0.470 = 1.73 SD); 100: 0.264 → ×/÷1.30, **×/÷1.3**.

Resulting windows for R_measured:

| Rung | 2→1 window | 2→3 window |
|---|---|---|
| 300 | 3.108 ×/÷1.6 → **1.94 – 4.97**, > 1 | 1.460 ×/÷1.6 → **0.91 – 2.34**, and > 1 → **1.00 – 2.34** |
| 200 | 2.129 ×/÷1.6 → **1.33 – 3.41** | 1.287 ×/÷1.6 → 0.80 – 2.06, > 1 → **1.00 – 2.06** |
| 100 | 1.199 ×/÷1.3 → **0.92 – 1.56** | 1.000 ×/÷1.3 → **0.77 – 1.30** |

- **S-300:** **both** 300 RPS transitions (2→1 and 2→3) pass.
- **S-other:** **≥ 3 of the 4** transitions at 200 and 100 pass.

For reference, scale-v1 (training data, not evidence) measured R(300) = 2.30 for 2→1 and 1.99 for 2→3. Both fall inside these windows.

### 7.5 Pass rates [DERIVED: `simulate_pass_rates.py`, 200,000 draws]
**These are simulations under assumed noise and independence, not known probabilities.** Assumptions: the model is exactly right in expectation; per-cell structural error σ_s = 0.095, independent across cells; rep noise σ_r = 0.25 (0.093 at 100 RPS), log-normal, independent; the engine baseline equals the 1.2.14 reference values. Correlated errors, heavier tails or a campaign-level shift would lower these rates.

| Check | Simulated pass rate for a correct model |
|---|---:|
| one 200/300 cell median in tolerance | 95% |
| A-a (≥ 8/9, all three 300 cells) | 86% |
| A-b | 97% |
| A-c | 92% |
| **Absolute verdict (A-a ∧ A-b ∧ A-c)** | **80%** |
| S-300 | 82% |
| S-other | 91% |
| **Server-change verdict (S-300 ∧ S-other)** | **74%** |
| **Both verdicts** | **66%** |

Even if the model is right, the simulation says it fails the absolute verdict about 1 time in 5 and the joint result about 1 time in 3. That is the cost of n = 3 at noisy 300 RPS. Kevin accepts this, or else increases reps (D3). The criteria are not loosened after the data is seen.

### 7.6 Outcomes and engine-ticket gating
The two verdicts are **reported separately**. Neither implies the other.
- **Both pass:** the candidate is validated for absolute P95 and for 2→1 / 2→3 server changes, under the tested conditions (≤ 300/node, ≤ 300 total RPS, this topology). Only in this case may the result be described as "the scaling limitation is resolved". **Gating:** an engine ticket to implement it (new calibration id, version bump, this campaign recorded as its validation holdout) may be filed, and **Kevin decides** whether to file it.
- **Absolute passes, server change fails:** report as "**absolute P95 validated under tested conditions**; server-change prediction **not** validated". Do **not** claim that scaling is fixed. **No engine ticket** for this candidate (D11 has no exception). The accuracy page keeps its server-count caveat. Kevin may only decide how the partial result is worded on the page.
- **Absolute fails:** the candidate is not validated and is not implemented as-is. If the server-change verdict passed, report it, but it does not rescue the absolute result. The accuracy page keeps its caveat. Data from this campaign may inform a new candidate, which would need a new holdout.
- **Failing A-c alone** (everything else passes, but the engine scores at least as well in some 300 cell): this means only that **the candidate did not beat the frozen baseline under this criterion** in that cell. It says nothing about why. It does not mean the measured latency came in low, and it does not mean the engine is right. The absolute verdict is still a fail.
- No partial credit, no re-scoring with adjusted tolerances, no dropped cells except through §7.7.

### 7.7 Invalidation, missing data and replacement budget (objective; frozen)
Checked by `score_p95_v1.py` after every collect, before the next rung starts where possible:

| Condition | Rule |
|---|---|
| **Generator validity.** Generator CPU mean over the steady window **> 70%**, or k6 `dropped_iterations` > 0.5% of the **scheduled iterations for the whole rung** (target RPS × (ramp-equivalent 150 s + 900 s steady); e.g. 315,000 at 300 RPS, so > 1,575 dropped). **If generator CPU data is unavailable** after the CloudWatch re-collects below, the rung passes this check only if dropped iterations are ≤ 0.5% **and** k6 peak VUs stayed under the pre-allocated VU budget; otherwise it is treated as generator-invalid. The CloudWatch "rung still counts" rule below does not override this check. | That rung is invalid. **Re-run the whole apply once** as a replacement (letter suffix). Rungs inside an apply are never re-run, because a re-run would break the fresh-seed reverse ladder. If the replacement is also saturated, the cell is reported as **invalid (generator)**. |
| **CloudWatch partial** (any required per-minute metric missing more than 2 of the steady minutes, or `cloudwatch.window.source != "persisted-run"`) | **Re-collect** with explicit `CWM_RUN_STARTED_AT`/`CWM_RUN_ENDED_AT` for that rung, up to 2 attempts. The k6 data stays as it is. If still partial: the scored P95 is unaffected (it comes from k6), so the rung counts, and the gap is noted as descriptive loss. |
| **Identity mismatch** (`identityMatches` false, app count ≠ N, wrong SHA ≠ `measurement_sha`, wrong profile/workers/adapter, or a reused key) | The **whole apply is invalid** and is replaced. |
| **k6 summary missing or `latency.p95Ms` null** | Re-collect up to 2 times. If still missing, the apply is invalid and replaced. |
| **k6 per-minute output missing** | Re-collect once. If still missing, the rung **still scores** (scored P95 is the summary aggregate, §4.1); per-minute is descriptive. **If it is missing in ≥ 2 applies**, pause the campaign. |
| `latency.p95Ms` is not the untagged aggregate (a steady sub-metric appeared) | The apply is invalid (definition violation, §4.1); pause the campaign. |
| Failed apply, failed wait-ready, collect error, or an incomplete ladder | Replace the apply. |
| RDS version change mid-campaign | **Not** an invalidation. Recorded and reported as a confound. |

**Code changes mid-campaign:** the evidence package and `measurement_sha` are frozen. If any rule above requires a wiring or instrumentation fix, the current campaign is **paused**, and the fix ships as a **new campaign version** (`typical-p95-v1.1`) with a new `measurement_sha`. Applies run on different SHAs are **never pooled** in one cell. Applies completed before the fix are kept and reported under v1; v1.1 reruns all 9 cells from scratch. Kevin approves each such restart.

**Replacement budget:** at most **6 replacement applies in total** (any reason), and a soft cap of **$40 total AWS spend** for the campaign, including Extended Support. If a seventh replacement would be needed or the next apply would push spend past $40: **pause**, destroy any live stack, and ask Kevin whether to raise the budget and continue or to stop. Only if Kevin chooses to stop is the result reported as **partial, labeled "PARTIAL: budget exhausted"**. A raised budget is recorded in the evidence with its date and does not change any frozen prediction, tolerance or criterion. Cells with fewer than 3 valid reps are reported but **not scored**, and neither verdict is issued unless every cell it needs has 3 valid reps. Failed applies are kept as evidence.

### 7.8 No refitting
Nothing in `recommended-params.json`, the tolerances, the tolerance multipliers or the criteria changes after the freeze.

## 8. Run plan

### 8.1 Before session 1
1. Kevin approves §12. 2. Wiring PR merged (§9) and dry run passes (§5.4.6). 3. Engine freeze via MCP for 9 cells (§5.2). 4. Evidence package commit → `measurement_sha`.

### 8.2 Per apply (×9 in §3 order)
apply with `test_id`, the pinned AMI and `app_source_git_ref = measurement_sha` → wait-ready (verify adapter, server count, profile typical, 2 workers, SHA) → record RDS version → rungs 300, 200, 100, each with collect and the §7.7 checks → destroy → immediate leftover check → 15-min recheck (scale-v1 runbook §8).

### 8.3 Time and cost [DERIVED from scale-v1: ~76 min per 3-rung apply, < $1/h infra]

| Item | Time | Cost |
|---|---|---|
| 9 applies | 9 × 76 min = 684 min ≈ **11.4 h** over 3 days (~3.8 h/day) | infra < **$11.4** |
| Extended Support [ASSUMPTION ~$0.20/h for db.r5.large: 2 vCPU × ~$0.10/vCPU-h] | 11.4 h | ≈ **$2.3** |
| **Planned total** | **≈ 11.4 h** | **≈ $12–14** |
| Replacement budget (≤ 6 applies) | + ≤ 7.6 h | + ≤ ~$8 (infra + ES) |
| **Worst case within budget** | **≈ 19 h** (6 replacements) | **≈ $20–22**, soft cap **$40** (pause and ask Kevin) |

## 9. Wiring changes (described only; no code here)
- Register the new test IDs and rung keys (§3); the scorer rejects reused keys.
- A **ladder parameter** (`ladder=[300,200,100]`) in place of the hard-coded ascending ladder, with `rung_pos`/`ladder_history` written into metadata.
- 1× support exists already (scale-v1).
- **k6 request-level raw output** (`--out json` or CSV, gzipped) collected next to the summary, so steady-only P95 and per-minute percentiles are computed from individual request samples, **without adding k6 thresholds or anything else that creates a `phase:steady` `http_req_duration` sub-metric** (§4.1).
- Optional: event-loop lag and pool-wait log lines.
- Adapter 1.6.0 bump; the scale-v1 collect format is otherwise unchanged.

## 10. Risks and gotchas
- **Reverse ladder and cold start.** The scored window includes the warmup ramp (§4.1), and on the first rung that ramp runs on a cold buffer pool and fresh Node processes. Intended, because the definition matches training. Steady-only P95 is reported descriptively to show the transient. Not a reason to re-score.
- **1×-300 at the per-node edge** (§3). Only one training cell sits there. 1× at 300 also showed some unclassified errors in scale-v1 (56 of 315k in r1). Errors are recorded, not scored here.
- **RDS version drift:** recorded and reported, not grounds for exclusion.
- **Connections:** 1× puts the whole pool on one node (≤ 250 by the pool limit) against a DB cap of 500. No limit risk is expected; recorded descriptively.
- **Generator:** k6 must not be the bottleneck; §7.7 rule.
- **Noise:** the §7.5 rates are simulated under assumptions; real failure rates for a correct model may be higher.
- **Engine version:** the baseline is whatever the engine returns at freeze (1.2.17 expected).

## 11. Out of scope
Refitting; > 300 per-node RPS and > 300 total RPS (the tangent branch and the total-RPS cap stay untested); P50/P99 modeling; failure tests; engine, Replit or website changes.

## 12. Decisions (recommended default in **bold**)

| ID | Decision | Default |
|---|---|---|
| D1 | Configs | **1×, 2×, 3×** (rev 2) |
| D2 | Ladder | **300→200→100, full** |
| D3 | Reps / order | **3 applies per config, 3 UTC days, Latin square (§3)**; more reps would raise the pass rates at extra cost |
| D4 | Tolerance | **acceptance tolerance ×0.666 – ×1.432** (not a predictive interval) |
| D5 | Server-change verdict | **separate verdict; required for any "scaling resolved" claim and for the engine ticket**; tolerances ×/÷1.6 (200/300), ×/÷1.3 (100) |
| D6 | Scored window | **whole k6 run (warmup ramp + steady), as in training (§4.1)** |
| D7 | Pool-wait / event-loop instrumentation | **optional if cheap** |
| D8 | k6 per-minute output | **required (descriptive)** |
| D9 | Engine baseline | **freeze the live engine, record the returned version** |
| D10 | Replacement budget | **≤ 6 replacement applies, ≤ $40 total; otherwise pause and ask Kevin to raise the budget or stop (PARTIAL only if he stops)** |
| D11 | Engine-ticket gating | **only if both verdicts pass; then Kevin decides whether to file. No exception for absolute-only** |

## 13. Names and paths
- Campaign `typical-p95-v1`; repo folder `typical/p95-v1/` in `canvascloudai/cwm-bench` (at freeze).
- Draft paths `/workspace/p95-analysis/holdout/` (`PREREGISTRATION-DRAFT.md`, `SUMMARY.md`, `predict_p95.py`, `recommended-params.json`, `model-predictions.csv`, `simulate_pass_rates.py`) and the rev 1 backup `/tmp/prereg-v0.md` are outside this repo. The committed copies are the files in `typical/p95-v1/`.
