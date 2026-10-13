# cwm-bench `typical-dbsat-v1`: DB breakpoint discovery (2× / 3× / 4× m5.large, ascending ladder to 1,500 RPS), pre-registration

Status: **r4, frozen on merge of the typical-dbsat-v1 wiring PR** (drafts r1–r3 and the r4 changelog are in §14). Nothing applied on AWS and nothing filed in Replit at freeze. Written 2026-10-13. Owner: Kevin Brown. Engine 1.2.21 predictions are frozen in `predictions/engine-1.2.21/`. Controller 1.1.0 behaviour required by §7 is specified in `CONTROLLER-SPEC.md` (the controller is runner-side, not in this repo).
Once `measurement_sha` is fixed (§9), any change to §2–§8 means a new campaign version (`typical-dbsat-v2`). Pooling across SHAs is not allowed.

Labels: **[FACT]** in the repo or a saved artifact, cited inline · **[DECISION]** a choice for this campaign · **[ASSUMPTION]** an unverified premise · **[DERIVED]** arithmetic, shown · **[OPEN]** needs Kevin.

---

## 0. Summary

Find the load at which **adding an app replica gives no improvement exceeding the preregistered threshold** (×1.45 steady P95, or the error/throughput thresholds of §6.1) **because MySQL (db.r5.large) shows pressure while the app tier and generator have headroom**. Otherwise, report honestly that **no DB breakpoint was established within the tested range**. A breakpoint needs a **demonstrated lower bound**: a step where the extra replica *did* improve beyond threshold. Actual P95, throughput and error differences and their ratios are always reported, so smaller real improvements (e.g. 20%) stay visible even when they are below threshold. This answers a Product Hunt question. The campaign reuses the frozen typical-v1 workload and the p95-v1 harness/controller. It runs **2×, 3× and 4× m5.large** on an **ascending ladder 300 → 500 → 700 → 900 → 1100 → 1300 → 1500 total RPS**. Each step is 5 min warmup plus 15 min steady. There are **2 discovery reps per server count** (6 applies, Latin square over 2–3 UTC days), then a **separate confirmation test** (§7.4) that reproduces load history. The primary metric is **steady-window P95**. Engine 1.2.21 predictions are frozen and **descriptive only**. Nothing is scored against the engine, and nothing is refit.

Possible outcomes per transition (N→N+1), all reportable (§7.3):
- **DB breakpoint range [S_prev, S\*]**, candidate or confirmed;
- **DB pressure observed at X, no replica-benefit transition located**;
- **App/other bottleneck**;
- **Inconclusive** at a step;
- **No DB breakpoint established within tested range**;
- **Below tested range**, with no breakpoint claim.

## 1. Questions

- Q1. For each transition 2→3 and 3→4, is there a lowest step at which N+1 servers show no improvement exceeding the preregistered threshold (§6.1), with a lower step that did improve?
- Q2. At that step, does the DB show pressure (§6.2) while the app tier and generator still have headroom (§6.3)?
- Q3. Descriptive: wait-event mix (CPU / IO / lock) and connection behaviour across the ladder; behaviour against an illustrative 50 ms P95 target; and engine 1.2.21 predictions next to the measurements.

## 2. Fixed topology [FACT unless marked]

This is the same stack as typical-p95-v1 §2: us-east-2; internal ALB; m5.large app servers on pinned AMI `ami-0d3d85815a9746bc5`; Node typical CRUD service, `app_workers=2`, per-node mysql2 pool 250 (`app_pool_size`), `queueLimit` 50 per worker; db.r5.large MySQL 8.0, single-AZ, gp2 100 GiB, `max_connections` 500; c6i.xlarge k6 generator; frozen typical-v1 mix; fresh seed per apply.
- [FACT] Terraform `app_count` has no upper validation, so 4 is accepted (`terraform/variables.tf`). `rds.tf` currently sets `performance_insights_enabled = false`.
- [FACT] The pool ceiling exceeds `max_connections` at 3× (750) and 4× (1,000) against 500. In p95-v1, 3× peaked at 342 connections with 0 connection errors. [DECISION] `max_connections` stays at 500. Hitting that cap is a legitimate DB-side limit and is reported under §6.2(d). It is not avoided. [OPEN Q3] Alternatively, run a 4× variant with `app_pool_size=125`.
- [OPEN Q1] RDS engine version: pin `8.0.46-rds.20260908` (used on all p95-v1 applies) if AWS still offers it. Otherwise record the version per apply and treat a change as a confound.

## 3. Configuration, ladder and schedule

| Item | Value |
|---|---|
| Server counts | 2, 3, 4 × m5.large |
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, **ascending**; no retries within an apply |
| Step | 5 min warmup ramp + 15 min steady (`DEFAULT_WARMUP='5m'`, `DEFAULT_DURATION='15m'`) |
| Inter-step gap | Existing controller wait-ready only. Recovery checks (§7.2) apply **only after a breach** |
| Discovery | 2 reps × 3 server counts = **6 applies, up to 42 steps** |
| Confirmation | 1 apply per server count needed by §7.4, each running the full ascending conditioning ladder from 300 up to S_next (§7.4); fixed order 2× → 3× → 4×, back to back |
| Schedule | Latin square over 2–3 UTC days: D1 2×,3×,4×; D2 4×,2×,3×; optional D3 used for overflow or a split (applies are ~3 h each, §11) |

[DERIVED] One full apply takes 7 × 20 min = 140 min of load, plus ~35–45 min for apply, RDS creation, wait-ready, collect and destroy, so ≈ 3 h.

## 4. Metrics

### 4.1 Primary: steady-window P95 [DECISION]
This is k6 client-side `http_req_duration` p(95), computed from request-level samples (`k6.json.gz`) whose timestamps fall in the 15-min steady window (same code as `score_p95_v1.py` `steady_window`/`steady_only_p95`, nearest-rank). **Whole-step P95** (the untagged aggregate including warmup, the p95-v1 scored definition) is reported alongside for continuity. Still **no k6 thresholds**, because a `phase:steady` sub-metric would change the whole-step definition.

### 4.2 Other per-step metrics
| Metric | Source | Window |
|---|---|---|
| Errors by class (db_timeout, too_many_connections, queue_full, cpu_overload, internal, iops_throttle, unclassified) and total error rate | adapter `errorCategories`, k6 `http_req_failed` | steady, plus per-minute |
| Achieved vs requested RPS (k6 `http_reqs` rate, ALB RequestCount), dropped iterations | k6 summary, CloudWatch | steady |
| App CPU per node, generator CPU, generator NetworkOut/In | CloudWatch EC2 | per-minute and steady mean |
| DB CPU, DatabaseConnections (avg/max) vs `max_connections`, ReadIOPS/WriteIOPS, BurstBalance | CloudWatch RDS | per-minute and steady |
| **PI DB load (AAS)** by wait class (CPU / IO / Lock / other), top waits | RDS Performance Insights `GetResourceMetrics` (`db.load.avg` grouped by `db.wait_event_type` and `db.wait_event`) | per-minute and steady |
| **App pool wait** (time requests wait for a mysql2 connection), pool queue depth, event-loop lag | **not exposed today** [FACT: `app-typical/src/server.js` only detects `POOL_ENQUEUELIMIT`; `/api/meta` reports static pool config], so this is required wiring (§9) | per-minute |
| P50/P99, per-minute P95 (descriptive tail shape, never averaged into a percentile) | k6 samples | steady |
| Illustrative **50 ms P95 target**: which steps meet it | derived | **descriptive only**, never a verdict |

## 5. Engine predictions (frozen, descriptive only)
Before the first apply, freeze **engine 1.2.21** for all 21 (server × RPS) cells via `user-cwm` MCP. Use the p95-v1 baseline protocol: create with typical payload, seed 20240601 → step once → delete. Record P95, P50, CPU, DB CPU, errors, kind, calibrationId and the returned version. Commit these to `typical/dbsat-v1/predictions/engine-1.2.21/` before `measurement_sha`. **Wording:** 2–3 servers at ≤ 300 RPS are within engine 1.2.21's validated typical P95 scope. **4 servers, and every cell above 300 RPS, are outside it.** Engine numbers there are extrapolations, shown for comparison only. They are never scored and never used to pick steps.

## 6. Definitions used by the rules

### 6.0 Aggregation (frozen)
- Each **per-rep, per-step** quantity is computed over the **15-min steady window** of that step. The exception is breach detection, which is per-minute (§7.1).
  - P95 and pool-wait p95: percentile of all request samples in the window (nearest rank).
  - CPU, PI DB load (AAS), wait-class shares: **mean of the 15 one-minute values**.
  - Connections: **max of the 1-minute maxima**.
  - Error rates: errors / requests over the window.
  - Achieved RPS: requests / 900 s.
- Missing minutes: up to 2 missing minutes are tolerated; mean and max then use the minutes present. More than 2 missing makes that metric "not assessable" for that rep and step.
- **Every pressure (§6.2) and headroom (§6.3) threshold must hold in each discovery rep separately.** There is no averaging across reps for these thresholds.
- **Improvement (§6.1) is judged per rep pair.** Rep k of N+1 is compared with rep k of N, matched by Latin-square day where possible, otherwise by order. That gives two paired comparisons per step.

### 6.1 Improvement threshold and rep noise [DERIVED from p95-v1 `descriptive-rungs-20261010.json`]
In p95-v1, steady P95 across 3 reps had pooled log-SD **σ = 0.185**: median max/min ratio 1.23, worst 1.93 at 1×-200. The SD of a single-rep difference between two configs is σ·√2 = 0.26. [DECISION] The threshold is set at **×1.45 on P95** (log 0.37, ≈1.4 single-pair SD). Requiring it in **both** paired comparisons gives the protection against noise.

For a paired comparison at a step, **N+1 improves beyond threshold** if any of the following holds:
- **P95 ratio** R_p = P95(N) / P95(N+1) **> 1.45**; or
- **error difference**: error rate(N) − error rate(N+1) **> 1 pp** and error ratio E = err(N) / err(N+1) **≥ 2×**; or
- **throughput ratio** R_t = achieved RPS(N+1) / achieved RPS(N) **> 1.03**.

**Step classification (2 discovery pairs):**
- **Improves**: both pairs improve beyond threshold.
- **No improvement exceeding the threshold**: neither pair does.
- **Inconclusive**: one pair does and the other does not. An inconclusive step can serve neither as S_prev nor as S\*.

A breached step (§7.1) on N alongside a complete, non-breached step on N+1 counts as "improves" for that pair.

Error-ratio zero handling: if both error rates are 0, E = 1. If err(N+1) = 0 and err(N) > 0, E is undefined and is reported as "∞ (N+1 zero)". It passes the 2× criterion only if the pp drop is > 1. If err(N) = 0 and err(N+1) > 0, E is reported as "0 (N zero)", which fails.

**Always reported**, per pair and summarised across pairs. For the positive ratios (R_p, R_t, and E where finite and > 0) the summary is the **geometric mean**. For percentage-point error differences it is the **arithmetic mean**. Undefined or zero E values are listed per pair and not averaged. % changes are derived from the summarised ratios. Below-threshold improvements are reported as measured values (e.g. "+20% P95 improvement, below the ×1.45 threshold"). They are never reported as "no effect".

### 6.2 DB pressure (on N+1 at that step, in each rep; steady-window aggregates per §6.0)
Pressure types are reported **separately**. Any one counts as DB pressure:
- **CPU**: DB CPU mean **≥ 80%**, or PI AAS **≥ 2.0** (db.r5.large vCPU count) with CPU-wait share **≥ 60%**.
- **I/O**: PI AAS ≥ 2.0 with the IO wait share **≥ 40%**, or IO share ≥ 40% with AAS at least 3× the same apply's 300 RPS step.
- **Lock**: PI AAS ≥ 2.0 with the Lock wait share **≥ 40%**, or Lock share ≥ 40% with AAS at least 3× the 300 RPS step.
- **Connection-cap exhaustion**: connections max **≥ 475** (95% of 500), or `too_many_connections` errors **> 0.1%** of requests.
- `db_timeout` errors > 0.1% count as DB pressure **only with corroborating DB evidence** from the CPU, I/O or Lock criteria in the same rep and step. Without it, they are reported in the separate class **"unattributed timeout"**. They count as neither DB pressure nor app/other bottleneck. A step whose only signal is an unattributed timeout cannot serve as S\* and is reported as such.

### 6.3 Headroom (both configs at that step, in each rep; steady-window aggregates)
- App CPU mean on **every** node **< 70%**.
- Generator valid (§7.5): generator CPU mean < 70%, dropped iterations ≤ 0.5%, NetworkOut mean < 70% of instance baseline bandwidth.
- ALB `HTTPCode_ELB_5XX` ≤ 0.1% of requests and no TargetConnectionErrorCount.
- **Pool wait attribution** (pool signal = pool-wait p95 **> 10 ms** or `queue_full` > 0.1%). Labels describe co-occurrence and are not proof of causation:
  - Pool signal **while §6.2 DB pressure holds** is labelled **"pool waiting with DB pressure"**. It does **not** count against headroom.
  - Pool signal **without** DB pressure is labelled **app pool limit**. Headroom fails, and the outcome is app/other bottleneck.
  - **Mixed/uncertain**: the pool signal occurs with only partial DB evidence, or alongside another headroom signal near its limit (app CPU ≥ 60%, generator CPU ≥ 60%), so the instrumentation cannot separate the causes. The step cannot serve as S\*, and it is reported with all signals.
  - If pool-wait wiring is missing, attribution is "not assessable", and any breakpoint is capped at "candidate".

## 7. Rules (frozen)

### 7.1 Breach
A **breach** is **three consecutive one-minute windows** inside the steady window, each with error rate **> 5%** or P95 **> 2,000 ms**, evaluated live by the controller from per-minute k6 output. On breach: stop that step at the end of the third minute, **stop that apply's upward sweep** (no higher steps), and keep the step as an **overload observation**. An incomplete step is **never** used as a full 15-minute comparison. Its partial-window values are reported and labelled "overload, N min". A breach during warmup does not count. Warmup minutes over the limit are recorded only.

### 7.2 Recovery (after any breach, before any further load on that stack)
Within **15 min** of stopping, all of the following must hold for **3 consecutive minutes**: DB CPU **< 30%**; DatabaseConnections within **+20% (or +20 absolute, whichever is larger)** of the pre-ladder idle baseline recorded at wait-ready; PI DB load < 0.5 AAS. Then a **3-minute 100 RPS probe** must give steady P95 **≤ 1.5×** the apply's pre-ladder probe P95 (a 3-min 100 RPS probe run once right after wait-ready) and error rate < 0.1%. If any condition is not met within 15 min (one probe retry allowed within that window), **abort the run**: destroy, mark the apply "recovery failed", and do not use the stack further. A recovery failure after a workload-triggered breach is **valid overload evidence**, not an invalidation. It does **not** authorize a replacement, and every comparison completed before it is kept. Recovery is needed only if further testing on the stack is planned. [DECISION] After a breach in discovery, the apply ends anyway (the sweep stops). Recovery is then checked only to support the confirmation design and for evidence, and its failure does not invalidate the steps already completed.

### 7.3 Outcome rules (per transition N→N+1, discovery reps)
Step labels: **complete** (full 15-min steady window), **overload observation** (breached partway, §7.1), **not tested** (never reached because the sweep stopped, or the apply was aborted). Only complete steps on **both** configs can be S_prev or S\*.

**Candidate DB breakpoint [S_prev, S\*]**: S\* is the **lowest** complete step such that **all** of the following hold:
1. S\* is classified "no improvement exceeding the threshold" (§6.1). Inconclusive does not qualify.
2. DB pressure (§6.2) holds on N+1 at S\* **in both reps** (the type is reported).
3. Headroom (§6.3) holds on both configs at S\* **in both reps**.
4. **Lower bound demonstrated**: some complete step below S\* is classified "improves" (both pairs). S_prev is the **highest** such step below S\*. Steps between S_prev and S\* (inconclusive, or no improvement without pressure) are listed. The reported range is [S_prev, S\*].

**Other outcomes:**
- **DB pressure observed at X, no replica-benefit transition located**: conditions 1–3 hold at X, but no lower step shows "improves" (e.g. X = 300, or every lower step is inconclusive or below threshold).
- **Below tested range**: a special case of the above at X = 300. No breakpoint is claimed.
- **App/other bottleneck**: the lowest step where no improvement exceeds the threshold has headroom failing (app CPU, app pool limit, ALB, generator) or no DB pressure.
- **Inconclusive at step X**: reps disagree (§6.1). If the would-be S\* is inconclusive, the transition is reported "inconclusive at X" with all ratios. Confirmation is not triggered.
- **No DB breakpoint established within tested range**: every complete step improves, or no step meets conditions 1–4. Overload and not-tested steps are listed.

### 7.4 Confirmation (separate test; not pooled)
Triggered only for a **candidate DB breakpoint [S_prev, S\*]**. Run one new apply (rep 3) **for each server count in the comparison** (N and N+1). Each runs the **full ascending ladder from 300 up to S_next** (the step above S\*), or up to S\* when S\* = 1500 or S_next was breached or not tested in discovery. This **reproduces the discovery load history**. Steps below S_prev are conditioning only and are not evaluated. Breach and recovery rules (§7.1–7.2) apply unchanged. A workload-triggered breach or recovery failure during confirmation is **valid overload evidence**, not an invalid run. Completed comparisons are kept, and no replacement is authorized. If overload prevents reaching a step that the decision in (a)–(d) requires, the result is **"confirmation not completed due to overload"**, reported with all completed steps.
- Confirmation is evaluated **on its own single pair** (rep 3 of N vs rep 3 of N+1). It is **never pooled** into 3-rep medians.
- **Confirmed** if, within that single pair: (a) S_prev improves beyond threshold, (b) S\* shows no improvement exceeding the threshold, (c) DB pressure of the **same type** holds on N+1 at S\*, and (d) headroom holds on both at S\*.
- **Failed confirmation** (a valid run where any of (a)–(d) fails) is a **valid negative result**. It is **not retried**, and is reported as "candidate, not confirmed" with all confirmation ratios.
- **Invalid confirmation** (collection failure, generator-invalid step per §7.5, missing k6 or CloudWatch/PI data beyond the §6.0/§7.7 re-collect rules, or an infra/harness error) is **not** a result. A workload-triggered breach or recovery failure is never an invalid confirmation. It follows the frozen replacement rules (§7.7, letter suffix, counted against the 6-replacement cap and the pause-and-ask).
- S_next results are descriptive (to show the trend continues). They are not part of the decision.
- When S\* = 1500, the result is the range [S_prev, 1500] at most, with nothing above 1500 in v1.
- A candidate never has S\* = 300 (condition 4 requires a lower step), so there is no 200 RPS boundary step.
- **Fixed order 2× → 3× → 4×, back to back on one UTC day**, running only the server counts the triggered transitions need. If both 2→3 and 3→4 have candidates, a single shared 3× apply runs up to the higher of the two S_next values and is used in both pairs.

### 7.5 Generator validity
A step is generator-invalid if dropped iterations are **> 0.5% of scheduled iterations** (requested RPS × (150 s ramp-equivalent + 900 s)), or generator CPU steady mean > 70%. Before concluding that hardware is insufficient, diagnose in this order: (1) VU allocation (`preAllocatedVUs`/`maxVUs`; today ≥ 300 RPS gets 800/1600 [FACT `load/lib/common.js:104`], which needs to scale with RPS × P95), (2) generator CPU, (3) generator network and ephemeral ports. **Dry run [DECISION]:** one single apply, 4×, full ladder, one generator, unscored, run before `measurement_sha`. If it shows generator-invalid steps not fixed by VU allocation, use **2 generators** (k6 split by rate, `executionSegment`) for the whole campaign. **The 1-vs-2 generator arrangement and VU settings are frozen after the dry run.** A generator-invalid step in the campaign triggers a whole-apply replacement (letter suffix, counts against §7.7).

### 7.6 Engine
As §5: frozen 1.2.21, descriptive only, no verdict.

### 7.7 Budget and replacements
- **Soft cap $60** (spend-guard upper bound). At the cap, **pause and ask Kevin. Never auto-stop.**
- **Replacement applies capped at 6.** At the cap, pause and ask. Replacement is allowed **only** for measurement or harness failures: collection failure, a generator-invalid step (§7.5), data still missing after re-collects, or infra/harness errors. A workload-triggered breach (§7.1) or recovery failure (§7.2) is valid overload evidence in discovery and confirmation alike, and never authorizes a replacement.
- A code change mid-campaign (adapter, controller, app, Terraform, k6 script) means a **new version** (`typical-dbsat-v1.1`). **No pooling across SHAs.**
- Other invalidations follow p95-v1 §7.7: CloudWatch or PI re-collect up to 2 times; k6 summary missing → apply invalid.

### 7.8 No refitting
No engine ticket is gated on this campaign in v1. Any later modelling of DB saturation would treat these runs as fit data, and a separate holdout would be required.

## 8. Reporting
- Per-step table (server × RPS × rep): status (complete / overload observation, N min / not tested), steady P95, whole-step P95, P50/P99, error rate by class, achieved/requested RPS, app CPU, DB CPU, connections/500, PI AAS and wait shares (CPU/IO/Lock), pool-wait p95, generator CPU, engine 1.2.21 prediction (labelled in-scope or out-of-scope).
- Per transition and step, per pair: R_p, R_t, error difference and ratio, % change, classification (improves / no improvement exceeding threshold / inconclusive), and the DB pressure type(s) and pool-wait attribution.
- The outcome per §7.3, plus the confirmation result per §7.4, reported separately.
- Plain-language wording for the post: "Adding a 4th replica gave no improvement exceeding our preregistered threshold (×1.45 P95) between X and Y RPS, while MySQL showed <type> pressure; at X it still cut P95 by Z×. (Measured difference at Y: +n% P95.)" Otherwise the matching "no DB breakpoint established" or "app/other bottleneck" sentence. The 50 ms target is illustrative.

## 9. Required harness changes (before `measurement_sha`)
1. **Adapter 1.7.0**: `typical-dbsat-{2x,3x,4x}-{300…1500}` keys; `APP_COUNT_MISMATCH` accepts 4; ascending ladder param `[300,500,700,900,1100,1300,1500]`; per-minute k6 export kept; steady-only P95 computed from samples **inside the adapter collect** (not only offline); breach-stop flag and partial-step metadata.
2. **Controller 1.1.0**: live per-minute breach evaluation (§7.1) and sweep stop; recovery protocol with idle-baseline capture, 100 RPS probes and abort (§7.2); confirmation mode running an explicit step list; spend guard updated for 4× and 2 generators.
3. **4× support**: Terraform already accepts `app_count=4`. Check ALB target registration, wait-ready for 4 nodes, and per-node CloudWatch collection.
4. **Performance Insights**: `performance_insights_enabled = true` (7-day free retention) on the RDS instance; IAM `pi:GetResourceMetrics`; adapter collects `db.load.avg` by `db.wait_event_type` and top `db.wait_event` per minute.
5. **App pool metrics** (app-typical change, so a new `measurement_sha`): mysql2 acquire-wait timing per request (time from `getConnection` request to acquire), pool queue depth, event-loop lag; expose them via `/api/metrics` (per-minute histograms). This also closes p95-v1's D7.
6. **Generator option**: `generator_count` 1|2 in Terraform; k6 `executionSegment` split; summary and sample merge in the adapter; VU allocation scaled to target RPS (e.g. preAllocatedVUs = RPS × 0.5 s, maxVUs = RPS × 2.5 s).
7. **Engine 1.2.21 freeze script**: 21 cells via MCP, committed.
8. Dry-run evidence (§7.5) committed with the generator decision.

## 10. Risks
- The DB may never saturate up to 1,500 RPS: p95-v1 DB CPU was ~25% at 300 RPS. Linear extrapolation gives ~100% around 1,100–1,300 RPS [DERIVED: 25.8% × 1,200/300 ≈ 103%], but this mix may hit connection or lock limits first. Outcome (b) is acceptable.
- 2× may hit app CPU first (p95-v1 2× ~14% at 300, so roughly 70% at ~1,500). That shows up as "app bottleneck", not DB.
- Pool ceiling > `max_connections` at 3×/4× can produce `too_many_connections` errors. These are counted as DB pressure (d) by design. See Q3.
- An ascending ladder carries warm caches forward. Steady-only P95 reduces the effect of ramp transients.
- RDS minor-version drift (Q1).

## 11. Time and cost estimates [ASSUMPTION: us-east-2 on-demand list prices, Oct 2026; ESTIMATES, not bills]
| Item | $/h |
|---|---|
| m5.large | 0.096 |
| db.r5.large MySQL single-AZ | 0.250 |
| gp2 100 GiB (0.10/GB-mo) | ~0.014 |
| c6i.xlarge generator | 0.170 (×2 if two generators) |
| ALB hour + ~3–6 LCU at ≤1,500 RPS | ~0.05–0.07 |
| PI (7-day retention) | 0 |
| **Stack/h**: 2× / 3× / 4× (1 generator) | ≈ 0.68 / 0.77 / 0.87 |

[DERIVED] Discovery: 2 reps × 3 h × (0.68 + 0.77 + 0.87) ≈ **$14** (+$2 with 2 generators). Dry run ≈ $3. Confirmation, 2–3 applies × up to ~3 h (full ladder to S_next) ≈ $5–7. Replacements, up to 6 × ~$2.5 ≈ $15 worst case. Spend-guard margin aside, the total is **≈ $25–40**, under the $60 soft cap. Breaches shorten applies.
**Kevin's time:** ~1 day for wiring review and merges (§9), 2–3 days of runs (2–3 applies per day, mostly unattended), plus a confirmation session (~half to one day, since confirmation reruns the ladder).

## 12. Open questions for Kevin (recommended default in **bold**)
- Q1. Pin RDS minor version? (**pin 8.0.46-rds.20260908 if available**)
- Q2. Is 2 discovery reps enough, given σ from ≤ 300 RPS? (**yes; the third rep comes via confirmation**)
- Q3. Keep pool 250/node at 3×/4× (pool > max_connections), or scale the pool so the fleet total is 500? (**keep 250; report connection saturation as DB pressure**)
- Q4. Noise threshold fixed at ×1.45 per pair, required in both pairs? (**yes**)
- Q5. Breach thresholds 5% errors / 2 s P95: OK for a public post? (**yes**)
- Q6. Add 1× or 5× configs? (**no; 2/3/4 answers "does adding a replica help"**)
- Q7. Is the app pool-wait instrumentation (an app change, requiring a new app SHA) acceptable? If not, §6.3 is capped at "candidate". (**yes, add it**)
- Q8. Include the 2×-500 RPS point from typical-v1 as context in the post? (**context only, never pooled**)
- Q9. Who runs it: the same runner/controller as p95-v1? (**yes**)

- Q10–Q13 **decided in r3**: pair reps by Latin-square day; confirmation back to back on one UTC day (2× → 3× → 4×); no second attempt after a valid failed confirmation; uncorroborated DB timeouts → "unattributed timeout".

## 13. Names and paths
`typical/dbsat-v1/PREREGISTRATION.md`, `typical/dbsat-v1/predictions/engine-1.2.21/`, `typical/dbsat-v1/score_dbsat_v1.py`, evidence `typical/campaign/typical-dbsat-v1-<date>/`, exports `holdout/exports/typical-dbsat-v1-<date>.{summary.md,metrics.csv}`.

## 14. Changelog
- **r4 (2026-10-13)**
  1. Breach and recovery failure caused by the workload are valid overload evidence and never authorize a replacement. Completed comparisons are kept. New result "confirmation not completed due to overload". Replacement is limited to measurement/harness failures (§7.2, §7.4, §7.7).
  2. The "DB-caused pool waiting" label is removed; only "pool waiting with DB pressure" remains (§6.3).
- **r3 (2026-10-13)**
  0. Q10–Q13 adopted: pair by day, back-to-back confirmation, no retry after a valid failure, "unattributed timeout" class.
  1. §3 confirmation row now matches §7.4 (full conditioning ladder; "only the selected steps" removed).
  2. §6.2: uncorroborated timeouts become "unattributed timeout", not app/other.
  3. §6.1: arithmetic mean for pp error differences, geometric mean only for positive ratios; zero-denominator rules for the error ratio.
  4. §6.3: "pool waiting with DB pressure" (co-occurrence, not causation); new mixed/uncertain class; evidence needed for a stronger label.
  5. §7.4: failed confirmation (valid negative, no retry) separated from invalid confirmation (replacement rules and cap).
  6. §7.4: fixed confirmation order 2× → 3× → 4×, back to back, with a shared 3× run.
- **r2 (2026-10-13)**
  1. Verdict wording changed from "stops helping" to "no improvement exceeding the preregistered threshold (×1.45 P95, error, throughput)". Ratios and % changes are always reported, so sub-threshold gains are visible (§0, §6.1, §8).
  2. Lower bound required: S_prev must improve beyond threshold in both discovery pairs and again in confirmation. Added the outcome "DB pressure observed at X, no replica-benefit transition located" (§7.3).
  3. Confirmation reruns the full ascending ladder to S_next as conditioning and is a separate single-pair test, not pooled into 3-rep medians. Removed the 200 RPS boundary step; 300 becomes "below tested range", with no claim (§7.4).
  4. Attribution: `db_timeout` counts as pressure only with CPU/PI corroboration. Pool wait under DB pressure is DB-induced waiting; without DB pressure it is an app pool limit. Pressure types (connection cap / CPU / I/O / lock) are reported separately (§6.2, §6.3).
  5. Aggregation frozen (steady-window percentile/mean/max, missing-minute rule). Thresholds hold per rep. Paired-rep disagreement means inconclusive. Confirmation criteria defined. "Not tested" is separated from "overload observation" (§6.0, §6.1, §7.3).
- **r1 (2026-10-13)**: initial draft.
