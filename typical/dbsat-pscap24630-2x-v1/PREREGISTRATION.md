# typical-dbsat-pscap24630-2x-v1: 24,630 prepared-statement cap holdout (preregistration)

**Status:** draft for review (r4). This is not frozen and no apply is authorized until it merges. The merge commit is the freeze.
**Parent:** `typical-dbsat-conn-2x-v1.1` (`typical/dbsat-conn-2x-v1.1/PREREGISTRATION.md`, frozen at merge `ec3bb059`). Sibling: `typical-dbsat-pscap16k-2x-v1` (`typical/dbsat-pscap16k-2x-v1/PREREGISTRATION.md`). Unless a section below says otherwise, every section of the parent prereg applies unchanged.
**Owner approval:** Kevin approved the plan on 2026-10-27, approved opening this PR, and directed the r2, r3 and r4 revisions of the verdict basis and the cap.

## 1. Question and the claim a PASS makes
An unpublished, opt-in **trajectory candidate** predicts the MySQL prepared-statement count (`Prepared_stmt_count`) from elapsed time, offered load and open connections. This campaign tests one prospective prediction: **given the rung schedule as it unfolds (each rung's observed start and the observed exposure of earlier rungs), in which rung does MySQL first hit `max_prepared_stmt_count` (the first errno 1461)?** The topology is conn-2x-v1.1 with `max_prepared_stmt_count = 24630`.

- **A PASS claims only this:** the frozen candidate, given each rung's observed start and the observed exposure of earlier rungs, predicted the rung in which MySQL first hit its prepared-statement limit, for this topology, cap and rung schedule, in two fresh reps.
- It does **not** claim anything about the timing of the first 1461 within the rung, a forecast conditioned on the measured count (the anchored forecast, §5.6), other caps, other topologies, other rung schedules, connection or breach predictions, or causal structure.
- The cap and the schedule were chosen using the development campaigns (§5.9). The two fresh reps are the prospective test. Nothing about this ladder or cap was chosen independently of those campaigns.

## 2. Topology and the single intervention [DECISION]
- Everything is identical to conn-2x-v1.1 §2, and to pscap16k-2x-v1 §2 apart from the cap:
  - us-east-2, internal ALB, 2× m5.large app nodes on the same AMI;
  - workers 2, **pool 250 per app server**, queueLimit 50;
  - db.r5.large MySQL 8.0 at the same RDS engine version, `max_connections = 500` via the parameter group;
  - c6i.xlarge generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`;
  - same app, load and adapter code.
- **The only change:** `mysql_max_prepared_stmt_count = 24630` (conn-2x-v1.1 used 65528, pscap16k-2x-v1 used 16382). It is set explicitly in the parameter group. `wait-ready` verifies that the live value is 24630 and `in-sync` before any rung.
- Why 24,630 (§5.9): it is the integer that maximizes the minimum margin, in seconds and in statements, of the forecast's 700-rung crossing across the four historical gap patterns. It is deliberately not a value that appears in the fit data (16,382, 65,528) or in the superseded scenario (32,764).
- AWS account, resource and ARN IDs are redacted in all committed evidence.

## 3. Ladder and breach [as parent]
- Rungs **300 → 500 → 700 → 900 → 1100 → 1300 → 1500 RPS**, each 300 s linear warmup + 900 s steady (a 1,200 s planned workload), reused unchanged from conn-2x-v1.1 and pscap16k-2x-v1.
- The §3.1 breach rule is unchanged: 3 consecutive eligible minutes with error > 5% or P95 > 2000 ms. Stop at the breach. **The stop rule is not changed after any outcome is seen.**
- **2 reps** (r1, r2), plus replacements only as §7 allows.
- Inter-rung gaps are not paced by the controller. They come from the collect and diagnostics steps and have historically been about 270–1,400 s. They are neither changed nor fixed by this prereg, and **no manual delay or retry may change them** (§5.4).
- The breach rung is recorded descriptively. It is **not** scored, except through §5.5.

## 4. Measurements [as parent §4]
Observer polls run every **15 s** and record `Threads_connected`, `Prepared_stmt_count`, and the cumulative errno **1461** and **1040** counters from `performance_schema`. Raw k6, the app 500 bodies, and the InnoDB/error snapshot are recorded as in the parent prereg. Each rep's evidence also contains the timing inputs of §5.2 and the forecast records of §5.4.

## 5. Frozen prediction, timing contract and verdict [DECISION, frozen at merge]

### 5.1 Model (unchanged, not refit) and the t = 0 startup assumption
- Model: `mysql-prepared-statement-trajectory-v3`, an internal, opt-in, **unpublished** candidate ("the trajectory candidate").
  - Implementation commit **`ba432f902ba8c35de670448f4e43fdfce204c2ff`**; report commit **`8747a554126ee34b57898be44a74e579913f570b`**.
  - P̂ = P₀ + βₜ·(m/10)² + βᵣ·R/10,000 + β꜀·max(0, N − N₀), evaluated at each 15 s poll inside a rung's workload (the cap is the comparison threshold; the modeled count itself is not clipped). m is elapsed wall-clock minutes from **t = 0, the first rung's generator `started_at`** (§5.2), counted through gaps. R is the cumulative **scheduled** (not measured) offered requests over the observed workload windows. N is the **frozen** connection estimate of the rung. Observed connection counts are never substituted.
- Fitted terms, frozen: βₜ = **29.8120561524** per (10 min)² of elapsed time; βᵣ = **33.6008348159** per 10,000 scheduled requests; β꜀ = **38.9871549291** per net open connection.
- Fit on 1,221 uncensored polls from 5 campaigns (rows at or above the statement cap were treated as right-censored and excluded): conn-2x-v1.1, conn-3x-v1, pscap-v1, pscap16k-2x-v1 and dbsat-v1. The only caps in the fit data are 16,382 and 65,528.
- Leave-one-campaign-out RMSE, in prepared statements: conn-2x-v1.1 2,874.8; conn-3x-v1 1,896.2; pscap-v1 1,553.3; pscap16k-2x-v1 1,437.3; dbsat-v1 1,463.3 (median 1,553.252). Full-fit RMSE on the two pscap16k reps: r1b 1,443.3 and r2 686.4. These are model-fit facts. They set no verdict threshold.
- Initial state: P₀ = **928** statements and N₀ = **20** connections (rounded medians of the first poll of the four scored 2× runs).
- Connection estimates N per rung (RPS: N), median of per-run medians of the exact 2× observer polls: **300: 130; 500: 279; 700: 491; 900: 500; 1100: 500; 1300: 500; 1500: 500**.
- **Startup assumption (frozen):** at a rung's first modeled poll the model substitutes the rung's frozen connection estimate **immediately**. For the first rung that is 130 connections at once, so the first modeled poll is P₀ + β꜀·110 = **5,216.6** (plus a time term below 0.1), where the real count at that moment is about 900. The real connections ramp over the warmup. The model's early-rung counts therefore overstate the measured counts (§5.8), and that is part of what this campaign tests. It is not corrected for.
- The formula and the forecast are committed as `typical/dbsat-pscap24630-2x-v1/predict.mjs`.

### 5.2 Timing contract (what the runner records, and what each time means)
All times are UTC. Verified from the adapter and controller code (`scripts/lib/adapter/run.mjs`, `cwm-bench-cpu-controller.ts rung()`, the conn2 build, health and evidence scripts of the executed pscap16k harness):

| Name | Source | Meaning |
|---|---|---|
| Controller dispatch | journal `startedAt` of a rung | when the controller dispatched the rung (SSM-launched). It is **not** the workload start. |
| **Workload start S_k** | journal `actualStartedAt` of rung k (the generator's `started_at`) | recorded by the generator just before it launches k6, 1 s resolution, with the generators' mutual sync check ≤ 10 s. **This is the workload start.** It is 10–47 s after the journal `startedAt` of the same rung (18.4–45.4 s in the first 3 rungs of the pscap16k reps; 10.5–21.7 s in conn-2x-v1.1 r1 and r2, except 46.8 s for r2's 900 rung). |
| **t = 0** | S₁, the first rung's workload start | the origin of elapsed time in the forecast. The fit's t = 0 (its first tagged poll) is 1.1–2.1 s after the first rung's dispatch, so S₁ is 18–47 s after the fit's origin (§5.7). |
| **Workload stop E_k** | the generators' `completed_at` (journal `endedAt` for a rung that ran to its end; the generator `completedAt` in `persisted-boundaries-<run>.json` for a breached rung) | the actual load stop. For a breached rung the journal `stoppedAt` is the controller's **breach declaration** and is **not** the stop: it was 9–57 s earlier than the generator stop in the historical reps. |
| k6 first sample | k6 request outcomes | descriptive cross-check only. |

- **Half-open workload interval** of rung k: **[S_k, E_k)**. Only the time inside a workload interval counts as exposure.
- **Excluded from rung membership:** controller dispatch time, the pre-k6 launch lag, collection, diagnostics and cleanup time after E_k, and any gap between rungs.
- **Frozen clock-skew limit:** **10 s** (the generators' existing sync limit). It is applied to the boundary rule below, and to the descriptive anchor.
- **Boundary-poll rule.** An observer poll at time p is *clearly inside* rung k iff S_k + 10 s ≤ p < E_k − 10 s, and *clearly outside* iff it is clearly inside no rung and within 10 s of no S_k or E_k. Otherwise it *straddles* a boundary. The first-1461 onset is the first poll whose cumulative 1461 counter is above the rep's first poll. The onset belongs to rung k only if **both** the onset poll and the poll before it are clearly inside rung k (the error happened in the interval between them). If both are clearly outside every rung it is a *gap onset*. In any other case it is a *boundary-straddling onset*. Gap and straddling onsets are **not assessable** (§5.5).
- The historical conn-2x-v1.1 reps have no controller journal on the box. Their workload start is the k6 request-level steady-window start (`steady_span_utc` of `records.json`) minus the 300 s warmup, and their stops come from `rung-tables.json` and the same steady span. These are descriptive inputs for the historical table only. The prospective reps use the generator-recorded values above.
- **Missing fields:** a rep without the first rung's workload start, or any started rung without a workload start or stop, is invalid (E9).

### 5.3 Gap and early-stop behavior [DECISION: one approach]
**Time continues through gaps, and nothing is modeled in a gap.** Gaps, pre-load time and post-stop idle time are **excluded from the claim**:
- No poll is modeled outside a workload interval. A first 1461 outside every workload interval (a gap onset) is **not assessable**. No post-stop idle evidence counts.
- The alternative (connections drop to baseline in gaps and crossings are evaluated) is **not used**, because the fit data do not support it. In every historical rep, `Threads_connected` and `Prepared_stmt_count` stay **constant** through every inter-rung gap (e.g. pscap16k r2: 141 connections and 6,380 statements across the gap after the 300 rung; 333 and 14,955 after the 500 rung; conn-2x r2: 139/7,038 and 216/12,396). The connection pool persists, so connections do not return to baseline. The gap behavior was never in the fit; it is outside what this prediction claims.
- Request exposure uses the **observed** workload window of each earlier rung (min(E_k − S_k, 1,200 s)), and the planned 1,200 s for the current rung.

### 5.4 Schedule-conditioned forecast (primary predictor)
At **each rung's workload start, before that rung has any outcome**, the runner records one forecast, computed with the frozen `predict.mjs` (`forecastRecord`):
1. **Inputs.** t = 0 = S₁. The observed `[S_i, E_i)` windows of all earlier rungs, the observed start S_k of rung k, the frozen constants of §5.1 and the cap. Nothing observed after S_k, no poll, no connection count and no outcome is an input.
2. **Forecast.** The frozen formula, from t = 0, evaluated at the 15 s grid s = 0, 15, …, 1,185 s from S_k, with the earlier rungs' observed exposure and this rung's scheduled ramp (300 s linear, then the rate).
3. **Predicted crossing:** the first grid poll with modeled count ≥ 24,630. The rung **predicts the first 1461** iff it has a crossing within its planned 1,200 s.
4. **Record.** The record holds the inputs, the crossing, the SHA-256 of the canonical inputs and of the output, and the runner's timestamp. It must be written no later than **S_k + 30 s**. The scorer recomputes it from the evidence timestamps. A missing record, a hash that does not recompute, or a record written later is a runner fault (E8). The runner keeps these records unedited.
- **Schedule-conditioned** means the forecast is conditioned on the schedule as it actually unfolded: it is not a forecast of the schedule and is not independent of it. Realized offsets are inputs, so the gap pattern matters (§5.9 shows how much).
- **No manual delays and no diagnostic retries that change timing.** This overrides the parent §7.1 harness-only permission and the inherited pre-workload retry rule for anything that affects timing, collection duration or journal semantics (including the gap between rungs, the dispatch-to-k6 lag, the stop rule and the journal fields of §5.2). Such a change **pauses the campaign and asks Kevin**. Cleanup-only actions after the load has stopped (parent §7.2a) are unchanged.

### 5.5 Primary verdict (per rep) [DECISION]
The rep is scored on **one thing: the rung that contains the first 1461.** There is **no timing tolerance** and no timing hurdle. For a valid rep (§5.10), walking the rungs that started, in order, by the first rule that applies:
1. The first-1461 onset is a **gap onset** or a **boundary-straddling onset** (§5.2): **NOT ASSESSABLE**.
2. The onset is in rung k:
   - **PASS** if rung k's forecast predicts the crossing (and, by the order of the walk, every earlier rung's forecast had no crossing and no 1461 occurred in it);
   - **FAIL** if rung k's forecast has no crossing.
3. No onset in rung k, and rung k's forecast **predicts a crossing**:
   - **FAIL** if rung k ran its planned workload (E_k − S_k ≥ 1,200 s) and no 1461 occurred in it. The first 1461 is then not in the predicted rung, whether it came later or never;
   - **NOT ASSESSABLE** if rung k stopped early (a valid early stop, for example a breach) with no 1461.
4. No onset in rung k, no predicted crossing in rung k: continue with rung k+1 if rung k ran its planned workload. If it stopped early, **NOT ASSESSABLE**.
5. All started rungs ran fully with no predicted crossing and no 1461: **NOT ASSESSABLE** (the prediction made no claim to test).

Campaign verdict:
- **PASS (H1):** both slots PASS.
- **H0:** at least one valid assessable slot is FAIL.
- **NOT DECIDED:** otherwise. This includes any slot that is NOT ASSESSABLE or still invalid after the allowed replacements (§7).

### 5.6 Descriptive results (no verdict effect)
Reported for every rep, with no threshold:
- the **onset timing error in seconds** versus the schedule-conditioned forecast (onset poll time − predicted crossing instant);
- the **state-anchored forecast** and its timing error. At each rung's start it takes the latest observer poll at or before S_k − 10 s (stale if older than 45 s at S_k, missing if none) and projects forward with the frozen model's increments only: the time-term delta from absolute elapsed time, this rung's request-exposure delta, and the connection delta of the frozen rung estimate versus the prior rung's. It uses the measured count and is **not** the predictor and is **not** hashed at rung start;
- the same formula on the fully observed schedule, the breach rung, TMC share, the connection curve versus the §5.1 estimates, P95, and the model's count versus the measured count at each poll.
There is no ±510 s hurdle. The earlier timing tolerance and its derivation from LOCO RMSE are dropped and are not part of the verdict.

### 5.7 Fit-pipeline mapping fixture
`tests/adapter/dbsat-pscap24630-score.test.mjs` (fixtures in `typical/dbsat-pscap24630-2x-v1/fixtures/`, byte-identical to the per-poll sources of §5.1 and §11) pins how the fit pipeline's origin and baseline map to the prospective calculation:

| Quantity | Fit pipeline | Prospective calculation |
|---|---|---|
| time origin | first tagged poll of rung 1, 1.1–2.1 s after the rung-1 journal `startedAt` | t = 0 = S₁, the first rung's generator start, 18–47 s later |
| baseline | P₀ and N₀ = the first tagged poll of each run, frozen at the medians 928 and 20 | P₀ = 928, N₀ = 20, frozen |
| rung start / exposure | first tagged poll of the rung (about the journal `startedAt`) | S_k, the generator-recorded k6 start, 10–47 s later |
| connections | observed `Threads_connected` | frozen per-rung estimate, never observed (§5.1 startup assumption) |
| polls | every tagged poll, gaps and idle time excluded | the 15 s grid inside [S_k, E_k) only |

The test also re-runs the fit pipeline on the two pscap16k per-poll sets and reproduces the published full-fit RMSE (1,443.2 and 686.4). The shift of the time origin raises the fit's elapsed time over the prospective one by 18–47 s, which changes the modeled count by under 45 statements at any poll of the first three rungs (tested). The requests the fit credits to the 10–47 s dispatch-to-k6 lead of each rung are not in the prospective calculation. These are documented differences, not corrections.

### 5.8 Historical table [DERIVED, descriptive]
Cap 24,630, evaluated with the committed code on the four historical gap patterns. t = 0 is each rep's first k6 start; the 300 and 500 rungs use their observed windows and the 700 rung is planned. The two pscap16k reps were run at cap 16,382, so their counts are censored at 16,382 and their real 700-rung crossing of 24,630 cannot be observed. The conn-2x-v1.1 reps (cap 65,528) are uncensored.

| Pattern | S₇₀₀ (s from t = 0) | Forecast crossing offset in the 700 rung | Margin from the rung edges | Model count at first / last 700 poll | Statement margin (below cap at start / above cap at end) |
|---|---:|---:|---:|---|---|
| pscap16k-2x-v1 r1b | 3,839 | 555 s | 555 s | 23,334 / 26,638 | 1,296 / 2,008 |
| pscap16k-2x-v1 r2 | 3,852 | 555 s | 555 s | 23,342 / 26,649 | 1,288 / 2,019 |
| conn-2x-v1.1 r1 | 3,121 | 705 s | 495 s | 22,920 / 26,083 | 1,710 / 1,453 |
| conn-2x-v1.1 r2 | 3,128 | 705 s | 495 s | 22,924 / 26,088 | 1,706 / 1,458 |

- **Minimum margins: 495 s from a rung edge and 1,288 statements.** The 300 and 500 forecasts have no crossing in any pattern (model maximum 14,417–14,552 before the 700 rung, so at least 10,078 statements of headroom).
- **Schedule sensitivity:** with nominal 300 and 500 windows, the 700 rung is the predicted rung for any 700 start between about 2,750 s (crossing at 795 s) and about 5,500 s (crossing at 15 s) after t = 0. Every historical pattern (3,121–3,852 s) is well inside that range.
- **In-sample check (real conn-2x counts, uncensored).** The real count first reaches 24,630 at the poll **369 s** (r1) and **395 s** (r2) into the 700 rung, so both reps are **inside the predicted rung** and would PASS. The real counts are 16,412 and 12,396 at the 700 rung start (8,218 and 12,234 below the cap) and 29,824 and 29,822 at its last poll (5,194 and 5,192 above the cap), so the real crossing is 369–395 s from the start edge and 805–831 s from the end edge. This is in-sample: the parameters were fit on these reps and the cap was chosen on their gap patterns.
- **Timing error, descriptive:** real first poll at or above the cap minus the forecast crossing: **−336 s** (r1) and **−310 s** (r2). The forecast crossing is late because the model's count rises more slowly through the rung than the real count does (the real count rises 13.4k in the 700 rung of conn-2x r1 and 17.4k in r2, against the model's 3.2k). The censoring at 16,382 prevents the same comparison for the pscap16k reps. For the earlier cap 23,552 the same errors were +24 s and +35 s; the cap choice trades timing agreement for margin from the rung edges and was deliberately not tuned to the realized timing.
- **State-anchored forecast at 24,630 (descriptive):** anchors at the 700 start of 16,382, 14,955, 16,412 and 12,396 give crossings at 0 s, 585 s, 0 s and **none** (the anchored forecast would not predict the 700 rung for conn-2x r2). That is why it is not the predictor: its count error at the first poll of a rung is −4.3k, −5.8k and −8.3k for the 300, 500 and 700 rungs because the model substitutes connections instantly.
- **Full-pipeline LOCO timing check: not run.** The five fold-parameter sets are not available as files that can be read here (the candidate's `loco.json` is over the read limit of the available tool). The LOCO RMSE of §5.1 is the only out-of-sample error figure.
- The pscap16k-2x-v1 r1b rep stopped its 700 rung 564 s after the generator start (the controller declared the breach at 542 s), with the 16,382 cap in force, so its behavior at this cap is unknown. The conn-2x-v1.1 reps ran the 700 rung to its planned end. Under §5.5 a rep like r1b that stops before any 1461 is NOT ASSESSABLE.

### 5.9 Choice of the cap [DECISION, a development-stage selection]
- **Rule (applied before freeze, using only the development campaigns):** over every integer cap from 20,000 to 30,000 except the fit-data and superseded values 16,382, 32,764 and 65,528, require that each of the four historical gap patterns forecasts its first crossing in the 700 rung and none earlier. For a cap c, let T(c) be the minimum over the patterns of min(crossing offset, 1,200 − crossing offset) (seconds from the rung edges, on the 15 s grid) and A(c) the minimum over the patterns of min(cap − model count at the first 700 poll, model count at the last 700 poll − cap) (statements). T peaks at **525 s** for caps 24,536–24,541, and A peaks at **1,370 statements** at 24,712–24,714. Choose the cap that maximizes min(T/525, A/1,370).
- **Result: 24,630**, T = 495 s (94% of its peak) and A = 1,288 statements (94% of its peak). Minimum margins are in §5.8. The T/A surface is flat near it: 24,540 gives 525 s / 1,198, 24,576 gives 510 s / 1,234, and 24,713 gives 465 s / 1,370. The 15 s poll grid makes T move in 15 s steps, so 24,630 is not special within that plateau.
- The earlier cap (23,552, chosen for the state-anchored forecast) gives 165 s and 210 statements under this predictor and is no longer used. Because the cap changed, the campaign ID changed (`pscap24630`).
- **Do the pscap16k histories bias the choice?** Yes, in one direction, and by a bounded amount.
  - Their rungs start later (700 start at 3,839–3,852 s against 3,121–3,128 s for conn-2x), so the model's time term is larger and its 700-rung counts are higher. Cap optima by pattern set: **conn-2x only** T peaks at 24,279 (600 s) and A at 24,503 (1,579); **pscap16k only** T peaks at 24,767 (600 s) and A at 24,990 (1,648); all four give 24,536 and 24,713. Using conn-2x alone would lower the cap by about 210–260 from the all-four optima; using pscap16k alone would raise it by about 230–280.
  - The pscap16k reps are censored at 16,382, so they say nothing about real counts above it. They enter only through their gap timing and through the fit rows below 16,382. The real in-sample crossing (§5.8) comes from conn-2x alone.
  - The real counts at both conn-2x reps rise earlier than the model's, so the real crossing is nearer the start of the rung than the forecast crossing. This does not affect the rung-level verdict, which needs only that the real onset is inside the 700 rung (real margins of 369 s and 805 s from the edges in-sample).
  - The two pscap16k reps' realized 700-rung behavior at this cap is unknown. They are development evidence for the gap pattern only.
- The 700 rung is reachable: all four earlier 2× reps ran it, and the conn-2x-v1.1 reps completed it.
- The earlier cap and prediction (32,764; 1100 rung) are archived as a separate **superseded** scenario in `superseded/pscap32k-prediction.md`. The earlier drafts of this PR (cap 24,576 with a timing tolerance, and cap 23,552 with a state-anchored predictor) are superseded by this revision and were never frozen. **Switching between scenarios after any outcome of any of them has been seen is banned.**

### 5.10 Validity (E7/E8 precedence)
- E1–E5 are as in conn-2x-v1.1 §5.5, and E5-pre/E5-breach are unchanged, except that the live parameter value in E1 is 24630 (replacing 65528).
- Additionally:
  - **E6:** the live parameter is 24630 and `in-sync` at wait-ready.
  - **E7:** no observer-poll gap longer than 30 s from the rep's first poll through the **decisive result** (§5.5: the onset poll, the end of the rung that decided it, or the end of the evidence when no decisive result exists). A poll gap after the decisive result does not matter.
  - **E8 (runner):** any runner-side fault **at or before the decisive result** makes the rep invalid. That includes runner CPU throttling, runner process or controller crash, runner transport loss, and a missing, altered or late forecast record. A fault **after** the decisive result is ignored.
  - **E9 (journal):** a rep with no first-rung workload start, or no workload start or stop for a rung that started, is invalid.
  - **E10 (counters):** a decrease of the cumulative errno 1461 or 1040 counter at or before the decisive result is invalid (a reset). One after it is ignored. Non-zero initial counters are allowed; the onset is an increase over the first poll.
- **E7 and E8 take precedence over the parent's post-breach rules:** a breach, a stop, or a 1461 does not excuse a runner fault or poll gap that came earlier, and does not make one that came later count.

### 5.11 Verdict table (executable)
`score.mjs` applies this table to the evidence; `tests/adapter/dbsat-pscap24630-score.test.mjs` has a test for each row.

| Case | Verdict |
|---|---|
| first 1461 in the predicted rung, any distance from the predicted instant | PASS |
| first 1461 in an adjacent rung (earlier rung with no forecast crossing, or later rung after a predicted rung ran fully with no 1461) | FAIL |
| first 1461 in a rung whose forecast has no crossing | FAIL |
| first 1461 in a gap or after the load stopped (gap onset) | NOT ASSESSABLE |
| onset poll or its previous poll within 10 s of a rung boundary | NOT ASSESSABLE |
| predicted rung stopped early (valid early stop) with no 1461 | NOT ASSESSABLE, not replaced |
| early stop after the first 1461 | decided by the onset |
| no predicted crossing and no 1461 | NOT ASSESSABLE |
| missing or stale anchor | no effect (the anchored forecast is descriptive) |
| missing journal fields | INVALID (E9), replaceable |
| non-zero initial error counters | onset = increase over the first poll |
| counter reset before the decisive result / after it | INVALID (E10) / ignored |
| runner fault or poll gap before / after the decisive result | INVALID / ignored |
| forecast record missing, altered or late | INVALID (E8) |
| PASS and PASS / any FAIL / otherwise | H1 / H0 / NOT DECIDED |

## 6. Scoring
- The **runner produces evidence**: the §5.2 timing inputs, the observer polls, the forecast records, and the fault log. A **separate scorer**, `typical/dbsat-pscap24630-2x-v1/score.mjs`, applies the frozen rules. It never runs or changes the workload. The runner does not compute verdicts.
- The scorer and `predict.mjs` are pinned by hash:
  - `predict.mjs` SHA-256 `447eb18f4f3c21745629f77ea0baffee1af6524a215da2fe88643a94d3b941ad`
  - `score.mjs` SHA-256 `43d64b75061c1753afde5203cf0fb65820639142c3533617442ff2aa6269ba4a`
  A change to either after the merge is a prereg change and is not allowed once an apply has started.
- **Descriptive only:** the §5.6 results.

## 7. Operations [as parent §7, with these changes]
- §7.1 runner autonomy, §7.2a cleanup-only after load, and §7.3 cleanup and redaction are unchanged, except that the inherited harness-only permission does **not** cover anything that affects timing, collection duration or journal semantics (§5.4).
- **Runner CPU:** the runner stays in **unlimited CPU-credit mode** for the whole campaign. Its mode is restored to standard before stopping (not terminating) the runner.
- **§7.2 replacements (this prereg overrides the parent's "a breach never authorizes a replacement" only for independently established execution faults):**
  - A replacement apply is allowed **only** for a slot whose rep is **INVALID** (§5.10), i.e. an independently established execution fault (E1–E10 other than a valid breach).
  - **A valid early stop, a breach, or a NOT ASSESSABLE rep is never replaced.** It keeps its slot, and the campaign is NOT DECIDED unless another slot is a FAIL.
  - At most **2** replacements in total across both slots, one at a time, with the next apply-ID letter. Replacements stop as soon as a valid assessable slot is FAIL.
  - Each replaced rep stays in the record and is not scored. An attempt after a non-invalid result in the same slot is ignored by the scorer and flagged as a deviation.
  - If the controller would have to change so that a run continues past a breach, that is a measurement-code change and the campaign **pauses** (parent §7.1).
- **Budget:** soft cap **$25** (spend-guard upper bound). At the cap, **pause and ask Kevin**. Never auto-stop.
- [DERIVED, rough] Spend estimate: comparable 2-rep campaigns spent $3.92 (conn-3x) and $4.42 (pscap-v1). Even with 2 replacements (4 applies) the expected spend is about $8–$10, under $25.

## 8. Harness [pinned, execution lock]
- **Measurement code:** `881e0cffd51da084be4a24ffd13366dfbb67063f` (unchanged).
- **Base harness:** the executed pscap16k-2x-v1 pair, which ran both of its scored reps: manifest SHA256 `c728cec226f4c474ee5805cc95a77dd3f689cb918e505f818da4eece2d38f93f`; controller SHA256 `1cace4511c217097718f321822b3bf037fd5dd5e538424fc27d7cb0ddcd3a110`.
- **Campaign harness:** the base harness plus this PR's adapter change (the pscap24630 ID family and the 24630 wait-ready pin in `scripts/lib/adapter/ladder.mjs` and `ready.mjs`). Its resulting manifest and controller SHA256 are **not yet known** and are recorded in a later revision of this prereg **before freeze**. The campaign does not start without them. Any later change follows §5.4 and parent §7.1.
- **Forecast hook:** the runner must call `predict.mjs forecastRecord` at each rung's workload start and store the record in the rung's evidence. This hook is a harness change (runner-side) that is not yet implemented or run; it must be in the campaign harness hashes above.
- **ID verification:** the new ID family is covered by unit tests of `ladder.mjs` and `wait-ready` (`tests/adapter/dbsat-pscap24630.test.mjs`) with a mocked AWS layer. It has **not** been run through a real observer or controller on a live stack, because no stack is up. It is therefore a **runner preflight check**: the first apply's `wait-ready` must succeed with a pscap24630 ID, and the live parameter must read 24630 and `in-sync`, before any rung.
- **Model:** the trajectory candidate, commits as in §5.1. Parameters are unchanged.

## 9. Names
- Campaign ID: `typical-dbsat-pscap24630-2x-v1-YYYYMMDD`.
- Apply IDs: `typical-dbsat-pscap24630-2x-r{1,2}[letter]-YYYYMMDD`. IDs are never reused.
- Evidence: `typical/campaign/<apply-id>/`.

## 10. Disclosures and risks
- **Expected outcome (a judgment, not a computed probability):** about **70% H1**, **10% H0**, **20% NOT DECIDED**.
  - A rep passes if the real count crosses 24,630 inside the 700 rung. In the two uncensored development reps it does so 369–395 s in, with about 5,200 statements of margin at the end of the rung and 8,200 or more at its start, and the end-of-rung real count was identical in both reps (29.8k). The model's forecast predicts the 700 rung for any realistic gap pattern (§5.8), so a FAIL needs a real onset in an adjacent rung or no onset in a fully run 700 rung, which no development rep suggests.
  - **NOT DECIDED** comes from an early stop before the first 1461 (the 564 s stop of pscap16k r1b came with the lower cap in force; a breach unrelated to the count in the first 400 s of the 700 rung has not been seen), from a gap or boundary-straddling onset (unlikely, since the onset is expected 370–400 s into a rung), and from replacements running out. Valid early stops are not replaced, so none of this risk can be bought back.
  - **H0** is the smaller risk because the rung-level rule has wide margins, but it is not zero: the real count could rise differently with a different gap pattern or with the changed cap, or a rung other than 700 could contain the onset.
  - The in-sample evidence is two reps whose gap patterns, parameters and cap selection were all development inputs. The probabilities above are therefore optimistic, and two pscap16k reps give no information at this cap.
- **The timing agreement is weak and is not claimed.** The forecast crossing is 310–336 s later than the real onset in the conn-2x reps (§5.8). The verdict is at rung level, and the descriptive timing error is reported.
- **Development-stage selection and fit provenance:** the candidate was fit on conn-2x-v1.1 and pscap16k-2x-v1 data, the gap patterns used to choose the cap come from the same campaigns, and the cap is a development selection (§5.9). The cap itself is not a value in the fit data. The time term is an empirical curve, not a causal statement. The two fresh reps are the prospective test.
- **Schedule-conditioned, not schedule-independent:** a different gap pattern changes the forecast, though not its rung over the range in §5.8.
- The two pscap16k reps are censored at 16,382, so their anchors at the 700 rung and their 700-rung crossings are not observed above that value.
- **Connection estimates** are medians of earlier 2× runs. The 700 estimate (491) is itself near the 500 `max_connections` limit.
- The **ladder is reused**. It was not chosen independently for this question.
- **Publish scope:** only the prepared-statement count trajectory and the 1461 cap signal are publish candidates. Connection, TMC and breach predictions are **not** publish candidates from this campaign, whatever the outcome.
- `Threads_connected` includes non-app sessions such as the observer and rdsadmin. The fit used the same measurement, so no correction is applied.

## 11. Provenance
- **Candidate source:** Replit app `4c3d147b-0fad-4908-8785-2b4236b54bab`, folder `reports/mysql-prepared-statement-trajectory-v3/`, read through the read-only app-file connector on 2026-10-27 (ET). Files read: `README.md`, `parameters.json`, `prediction-inputs.json`, `prediction.md`, `source-manifest.json`, `preservation-sha256.json`.
- **Hashes obtainable here:** the connector returns file text, not bytes, so the SHA-256 values below are of the returned text (without a trailing newline). They identify what was read and are **not** a hash of the stored bytes.
  - `parameters.json` `42d924838b087582f378e0b2a9c88b5a4910ed1d0727f91bd2dc33ce242a98eb`
  - `prediction-inputs.json` `b643b78ae19823dd1940411695f830914bdcc3948c6e30f5c086b048dba4e329`
  - `prediction.md` `5bb2c324c5d4a6f98ed4ab94d389fca6f9617a318000c86cb886920ce731e8c2`
  - `source-manifest.json` `3f9313132d7fd217723ca8c7124cbe350f4293d35c246fc2c19add60c16f6e96`
- **Not obtainable:** byte-level hashes of the Replit files; `prediction.json`, `loco.json` and `residuals.json` (over the connector's read limit, so not read); and any hash of the v3 folder in `preservation-sha256.json`, which hashes `mysql-limit-v2` paths and has no v3 entries. The implementation and report commits of §5.1 are the authoritative pins.
- **Source manifest, scripts and inclusion rules** (from `source-manifest.json`): fit campaigns and their revisions; rung windows from tagged polls (journal `startedAt` through `endedAt`/`stoppedAt`); elapsed time is wall-clock from the first rung start, including gaps; cumulative requests are schedule-derived; exposure starts at the first exact tagged poll and ends one median poll interval after; rows at the statement cap are censored and excluded; campaigns are weighted as in the manifest.
- **Per-poll sources (byte-identical to `typical/dbsat-pscap24630-2x-v1/fixtures/`):** conn-2x-v1.1 r1 `a433df998af2d0c54ed711885189a0481a3ec5b42bcb3c9cab40fca551f96d68`, r2 `04a0f04cfdc86b9cd97aab61ffd65ac942c1569af7c2bba29899af10b8698b4e`; pscap16k-2x-v1 r1b `481c554260cd1a8a73bad7b36710cbbee7b1d8b1de64ecacec4c2f146b05e1a5`, r2 `bde0a47383494197fe0c5b1be3e745cd862013fadf42e688f98f0bac29c1ae40`. Raw archives: conn-2x-v1.1 `56570a7e…f7997a4`, pscap16k-2x-v1 `c0eb0633…3476d` (abbreviated in the candidate's manifest).
- **Historical timing inputs:** `fixtures/historical-patterns.json` (`0016e26e92f927d89c1799ba2f89d583331c7cce6cf2f7a4f22d49dd5d520fc2`), derived from the pscap16k controller journal and persisted generator boundaries, and from conn-2x-v1.1 `rung-tables.json` and `records.json`. Offsets are seconds from each rep's first-rung dispatch; the tests rebase them to the first rung's k6 start. It holds only offsets in seconds and no identifiers.
- **Superseded scenario:** `superseded/pscap32k-prediction.md` (§5.9).

## 12. Changelog
- **r1 (2026-10-27):** initial draft (cap 24,576, rung-or-tolerance verdict, journal `startedAt` as the workload start).
- **r2 (2026-10-27):** review revisions: timing-only primary criterion, timing contract, startup assumption, gap behavior, replacement rule, separate scorer and tests, provenance.
- **r3 (2026-10-27):** verdict basis changed by Kevin to rung-level with a state-anchored forecast; the ±510 s tolerance dropped; cap 23,552; the PASS claim narrowed.
- **r4 (2026-10-27):** primary predictor changed by Kevin to the unanchored schedule-conditioned forecast (t = 0 at the first rung's generator start, observed windows, gaps excluded, hashed at each rung start); the anchored forecast is descriptive only; the cap re-chosen by a margin rule (24,630) and the campaign renamed `pscap24630`.
