# typical-dbsat-pscap24k-2x-v1: 24,576 prepared-statement cap holdout (preregistration)

**Status:** draft for review. This is not frozen and no apply is authorized until it merges. The merge commit is the freeze.
**Parent:** `typical-dbsat-conn-2x-v1.1` (`typical/dbsat-conn-2x-v1.1/PREREGISTRATION.md`, frozen at merge `ec3bb059`). Sibling: `typical-dbsat-pscap16k-2x-v1` (`typical/dbsat-pscap16k-2x-v1/PREREGISTRATION.md`). Unless a section below says otherwise, every section of the parent prereg applies unchanged.
**Owner approval:** Kevin approved the plan on 2026-10-27, and approved opening this PR.

## 1. Question
An unpublished, opt-in **trajectory candidate** predicts the MySQL prepared-statement count (`Prepared_stmt_count`) as a function of elapsed time, offered load and open connections. This campaign tests one prospective prediction of that candidate: on the conn-2x-v1.1 topology with `max_prepared_stmt_count = 24576`, **in which rung the first errno 1461 (cap hit) occurs**, when the model is evaluated on each rep's own measured rung start times.

The candidate was fit on five earlier campaigns (§5.1). It has not been evaluated on a cap other than 16,382 or 65,528. 24,576 is not a cap value in the fit data.

## 2. Topology and the single intervention [DECISION]
- Everything is identical to conn-2x-v1.1 §2, and to pscap16k-2x-v1 §2 apart from the cap:
  - us-east-2, internal ALB, 2× m5.large app nodes on the same AMI;
  - workers 2, **pool 250 per app server**, queueLimit 50;
  - db.r5.large MySQL 8.0 at the same RDS engine version, `max_connections = 500` via the parameter group;
  - c6i.xlarge generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`;
  - same app, load and adapter code.
- **The only change:** `mysql_max_prepared_stmt_count = 24576` (24 × 1024; conn-2x-v1.1 used 65528, pscap16k-2x-v1 used 16382). It is set explicitly in the parameter group. `wait-ready` verifies that the live value is 24576 and `in-sync` before any rung.
- Why 24,576 (§5.8): with the frozen formula it puts the predicted crossing near the middle of the 700 RPS rung under the median historical gap pattern, and keeps it inside the 700 rung under every historical gap pattern.
- AWS account, resource and ARN IDs are redacted in all committed evidence.

## 3. Ladder and breach [as parent]
- Rungs **300 → 500 → 700 → 900 → 1100 → 1300 → 1500 RPS**, each 300 s linear warmup + 900 s steady, reused unchanged from conn-2x-v1.1 and pscap16k-2x-v1.
- The §3.1 breach rule is unchanged: 3 consecutive eligible minutes with error > 5% or P95 > 2000 ms. Stop at the breach.
- **2 reps** (r1, r2), plus replacements only as §7 allows.
- Inter-rung gaps are not paced by the controller. They come from the collect and diagnostics steps and have historically been about 270–1,400 s. They are neither changed nor fixed by this prereg. They enter the prediction as measured inputs (§5.2).
- The breach rung is recorded descriptively. It is **not** scored, except through the assessability rule in §5.5.

## 4. Measurements [as parent §4]
Observer polls run every **15 s** and record `Threads_connected`, `Prepared_stmt_count`, and the cumulative errno **1461** and **1040** counters from `performance_schema`. Raw k6, the app 500 bodies, and the InnoDB/error snapshot are recorded as in the parent prereg. The controller journal (`runner-state.json`, rungs[].`startedAt`, `endedAt`, `stoppedAt`) is part of each rep's evidence.

## 5. Frozen prediction and hypotheses [DECISION, frozen at merge]

### 5.1 Model (unchanged, not refit)
- Model: `mysql-prepared-statement-trajectory-v3`, an internal, opt-in, **unpublished** candidate ("the trajectory candidate").
  - Implementation commit **`ba432f902ba8c35de670448f4e43fdfce204c2ff`**; report commit **`8747a554126ee34b57898be44a74e579913f570b`**.
  - P̂ = min( cap , P₀ + βₜ·(m/10)² + βᵣ·R/10,000 + β꜀·max(0, N − N₀) ), evaluated at each 15 s poll. m is elapsed wall-clock minutes. R is the cumulative scheduled (not measured) offered requests. N is the frozen connection estimate of the rung.
- Fitted terms, frozen:
  - βₜ = **29.8120561524** per (10 min)² of elapsed time;
  - βᵣ = **33.6008348159** per 10,000 scheduled requests;
  - β꜀ = **38.9871549291** per net open connection.
- Fit on 1,221 uncensored polls from 5 campaigns (rows at or above the statement cap were treated as right-censored and excluded): conn-2x-v1.1, conn-3x-v1, pscap-v1, pscap16k-2x-v1 and dbsat-v1. The only caps in the fit data are 16,382 and 65,528.
- Leave-one-campaign-out RMSE, in prepared statements: conn-2x-v1.1 2,874.8; conn-3x-v1 1,896.2; pscap-v1 1,553.3; pscap16k-2x-v1 1,437.3; dbsat-v1 1,463.3 (median 1,553.252). Full-fit RMSE on the two pscap16k reps: r1b 1,443.3 and r2 686.4.
- Initial state: P₀ = **928** statements and N₀ = **20** connections (rounded medians of the first poll of the four scored 2× runs).
- Connection estimates N per rung (RPS: N), median of per-run medians of the exact 2× observer polls (values above 900 RPS are an assumption and are not used by this campaign's cap): **300: 130; 500: 279; 700: 491; 900: 500; 1100: 500; 1300: 500; 1500: 500**.
- Model inputs and outputs are in the candidate repository at the report commit above. The newest per-poll sources are pinned here: conn-2x-v1.1 r1 `a433df998af2d0c54ed711885189a0481a3ec5b42bcb3c9cab40fca551f96d68`, r2 `04a0f04cfdc86b9cd97aab61ffd65ac942c1569af7c2bba29899af10b8698b4e`; pscap16k-2x-v1 r1b `481c554260cd1a8a73bad7b36710cbbee7b1d8b1de64ecacec4c2f146b05e1a5`, r2 `bde0a47383494197fe0c5b1be3e745cd862013fadf42e688f98f0bac29c1ae40`.
- The formula is committed as `typical/dbsat-pscap24k-2x-v1/predict.mjs` and re-computed by `tests/adapter/dbsat-pscap24k.test.mjs`.

### 5.2 Prediction procedure (per rep)
The predicted crossing is computed **after the fact from the rep's own measured rung start times**. Those times are inputs, not outcomes:
- **Time origin:** t = 0 at the first rung's controller-journal `startedAt`. Elapsed time runs continuously through the inter-rung gaps.
- **Rung k start:** the rung's journal `startedAt`, as seconds from t = 0. This is measured, not planned.
- **Polls:** the model is evaluated every 15 s at rung offsets s = 0, 15, …, 1185 s from each rung's `startedAt`. Nothing is modeled in the gaps.
- **Requests:** scheduled exposure. Each rung offers a 300 s linear ramp to its RPS, then its RPS to 1,200 s: RPS × 1,050 s per completed rung. Gaps add no requests.
- **Connections:** the frozen per-rung N of §5.1, constant over the rung.
- The **predicted crossing poll t\*** is the first modeled poll whose uncapped value is ≥ 24,576. The **predicted rung** is the rung containing t\*. Only rungs that actually started in the rep are used. If the formula does not reach 24,576 within the rungs that started, the rep has **no predicted crossing**.
- The rep's evidence contains the offsets, t\*, the predicted rung, and the modeled counts at each poll.

### 5.3 Tolerance (fixed now)
- **N = 34 polls (510 s).** Derivation: the median LOCO RMSE of 1,553.252 statements ÷ the model's local growth of **45.49 statements per 15 s poll** at the crossing under the median historical pattern (§5.6) = 34.14, rounded to 34. It is fixed at merge and is not recomputed per rep. Local growth under the four other patterns is 44.8–46.2 per poll.
- In wall-clock terms, an onset is within tolerance if |t₁₄₆₁ − t\*| ≤ 510 s.

### 5.4 Measured onset and rung windows
- The **measured onset** t₁₄₆₁ of a rep is the first observer poll where the cumulative errno 1461 counter is above its value at the rep's first poll.
- Rung windows are the controller-journal `startedAt` through `endedAt` (or `stoppedAt`), the same source and convention as the rung labels of the pscap16k poll series.

### 5.5 Assessability, hypotheses and verdict
For a **valid** rep (§5.6), by the first rule that applies:
1. **PASS:** a 1461 onset exists, a predicted crossing exists, and either the onset falls **in the predicted rung** (so no 1461 occurred in an earlier rung, since the onset is the first), or |t₁₄₆₁ − t\*| ≤ 34 polls.
2. **FAIL:** a 1461 onset exists and rule 1 does not hold. That includes an onset in a rung before the predicted rung, an onset after it, and an onset when the formula predicts no crossing in the rungs that started.
3. **FAIL:** no 1461 onset, and the rep's valid polls continued through the later of the end of the predicted rung's window and t\* + 34 polls.
4. **Not assessable:** no 1461 onset, and the ladder stopped (breach rule, errno 1040 or another cause) before the predicted rung started, before the later of the end of the predicted rung's window and t\* + 34 polls, or with no predicted crossing in the rungs that started. The rep is valid workload evidence but gives no test. It is reported with its breach rung.

Campaign verdict:
- **PASS (H1):** two valid assessable reps, **both PASS**.
- **H0:** at least one valid assessable rep is FAIL.
- **NOT DECIDED:** none FAIL, and fewer than two valid assessable PASS reps remain after replacements (§7).

Reported but not part of the verdict: the first-1461 offset from t\* in seconds, the breach rung, and the realized offsets.

### 5.6 Frozen prediction table [DERIVED, descriptive]
The table gives the formula's prediction for cap 24,576 under each historical gap pattern (the 300, 500 and 700 rung start offsets measured in the four earlier 2× reps), the median of those patterns, and the contiguous schedule used by the published model for reference. It does not set the verdict. The verdict uses each rep's own offsets (§5.2). The median pattern is the median of the four reps' start offsets per rung (500: 1,646.181 s; 700: 3,487.994 s). Sources: controller journals of pscap16k-2x-v1 and `rung-tables.json` of conn-2x-v1.1.

| Pattern | 500 start (s) | 700 start (s) | Modeled count at 700 start / end | Predicted crossing | Offset in 700 rung (s) | Ladder elapsed t\* (s) | Tolerance window in 700 rung (s) |
|---|---:|---:|---:|---|---:|---:|---|
| conn-2x-v1.1 r1 | 1,505.560 | 3,129.582 | 22,924 / 26,089 | 700 rung | 690 | 3,819.6 | 180 to 1,200 |
| conn-2x-v1.1 r2 | 1,528.505 | 3,128.904 | 22,924 / 26,089 | 700 rung | 690 | 3,818.9 | 180 to 1,200 |
| pscap16k-2x-v1 r1b | 1,804.885 | 3,865.928 | 23,351 / 26,660 | 700 rung | 525 | 4,390.9 | 15 to 1,035 |
| pscap16k-2x-v1 r2 | 1,763.857 | 3,846.406 | 23,339 / 26,644 | 700 rung | 525 | 4,371.4 | 15 to 1,035 |
| **median pattern** | 1,646.181 | 3,487.994 | 23,121 / 26,356 | 700 rung | **615** | 4,103.0 | 105 to 1,125 |
| contiguous (model's published schedule) | 1,200 | 2,400 | 22,590 / 25,612 | 700 rung | 840 | 3,240.0 | 330 to 1,350 |

- In every row, no modeled poll in the 300 or 500 rung reaches 24,576, and the count at the start of the 700 rung is 1,225–1,650 below the cap.
- The tolerance window extends beyond the rung's end only in the contiguous reference row. For the realized patterns the tolerance mostly restates the rung-level rule.
- The 700-rung counts are modeled values. The model has LOCO RMSE 1.4k–2.9k, which is larger than the 1.2k–2.1k headroom between the cap and the modeled 700-rung start and end counts. A real count can therefore be off by more than the rung's headroom (§10).

### 5.7 Reproduction
`predict.mjs` evaluates §5.1–§5.2. For example, the median pattern (offsets 0, 1,646.181, 3,487.994 s) gives, at the 615 s poll of the 700 rung, t = 4,102.994 s, 24,601.2 ≥ 24,576, and 24,555.8 at the 600 s poll.

### 5.8 Choice of the cap [DECISION]
- The cap was chosen by scanning every integer from 20,000 to 29,000 with the §5.2 formula, the five patterns of §5.6 (four historical reps and their median), and no reference to the fit data's caps (16,382 and 65,528).
- Every integer from 23,352 to 26,088 puts the crossing strictly after the first poll of the 700 rung and before its end, for all five patterns. Within that window, 24,500–24,546 maximizes the distance of the worst pattern from either edge of the rung (510 s).
- 24,576 (24 × 1024) was chosen as a round value near that optimum. Under it the crossing is 525–690 s into the 700 rung under the four historical patterns (615 s under the median). Every pattern is at least 525 s after the rung's start and 495 s before its end.
- Sensitivity: a cap of 23,351 or lower puts at least one pattern's crossing on the first poll of the 700 rung (or earlier), and a cap of 26,089 or higher puts at least one past its end. The cap is 1,225–1,652 above the modeled count at the start of the 700 rung and 1,513–2,084 below its end.
- The 700 rung is reachable: all four earlier 2× reps ran it, and conn-2x-v1.1 r1/r2 completed it.

### 5.9 Validity
- E1–E5 are as in conn-2x-v1.1 §5.5, and E5-pre/E5-breach are unchanged, except that the live-parameter value in E1 is 24576 (replacing 65528).
- Additionally:
  - **E6:** the live parameter is 24576 and `in-sync` at wait-ready.
  - **E7:** no observer-poll gap longer than 30 s from the rep's first poll through the later of the 1461 onset and t\* + 34 polls (or the end of the predicted rung, whichever is later), or through the end of the rep if neither is reached. Otherwise the rep is invalid.
  - **E8 (runner):** any runner-side fault before the scoring window ends makes the rep **invalid**. That includes runner CPU throttling, runner process or controller crash, and runner transport loss. Runner faults are never valid workload evidence.
  - **E9 (journal):** a rep with no controller-journal `startedAt` for a rung used in §5.2 is invalid, because the prediction cannot be evaluated.

## 6. Scoring
- An evaluation script is committed with the results, following the conn-2x-v1.1 pattern. For each rep it reads the journal offsets, computes t\*, the predicted rung and t₁₄₆₁ with `predict.mjs`, then applies §5.5 and §5.9.
- **Descriptive only:** breach rung, TMC share, connection curve vs the §5.1 estimates, P95, and the model's modeled count against the measured count at each poll.

## 7. Operations [as parent §7, with these changes]
- §7.1 runner autonomy (including its pre-workload retry rule), §7.2a cleanup-only after load, and §7.3 cleanup and redaction are unchanged.
- **Runner CPU:** the runner stays in **unlimited CPU-credit mode** for the whole campaign. Its mode is restored to standard before stopping (not terminating) the runner.
- **§7.2 replacements (this prereg overrides the parent's "a breach never authorizes a replacement" for not-assessable reps only):**
  - A replacement apply is allowed for a slot whose rep is **invalid** (§5.9) or **not assessable** (§5.5 rule 4).
  - At most **2** replacements in total across both slots. They run one at a time, and a replacement gets the next apply-ID letter.
  - Replacements stop as soon as a valid assessable rep is FAIL (the verdict is then H0).
  - Nothing else authorizes a replacement. Each replaced rep stays in the record and is not scored.
  - If the controller would have to change so that a run continues past a breach, that is a measurement-code change and the campaign **pauses** (parent §7.1) rather than proceeding.
- **Budget:** soft cap **$25** (spend-guard upper bound). At the cap, **pause and ask Kevin**. Never auto-stop.
- [DERIVED, rough] Spend estimate: comparable 2-rep campaigns spent $3.92 (conn-3x) and $4.42 (pscap-v1). This ladder is expected to stop around the 700–900 rung, as they did. Even with 2 replacements (4 applies) the expected spend is about $8–$10, under $25.

## 8. Harness [pinned]
- **Measurement code:** `881e0cffd51da084be4a24ffd13366dfbb67063f` (unchanged).
- **Base harness:** the executed pscap16k-2x-v1 pair, which ran both of its scored reps:
  - manifest SHA256 `c728cec226f4c474ee5805cc95a77dd3f689cb918e505f818da4eece2d38f93f`;
  - controller SHA256 `1cace4511c217097718f321822b3bf037fd5dd5e538424fc27d7cb0ddcd3a110`.
- **Campaign harness:** the base harness plus this PR's adapter change: the pscap24k ID family and the 24576 wait-ready pin (`scripts/lib/adapter/ladder.mjs`, `ready.mjs`, `tests/adapter/dbsat-pscap24k.test.mjs`). The resulting manifest and controller SHA256 are recorded in r2 of this prereg **before freeze**. Any later change follows parent §7.1.
- **Model:** the trajectory candidate, commits as in §5.1. Parameters are unchanged.

## 9. Names
- Campaign ID: `typical-dbsat-pscap24k-2x-v1-YYYYMMDD`.
- Apply IDs: `typical-dbsat-pscap24k-2x-r{1,2}[letter]-YYYYMMDD`. IDs are never reused.
- Evidence: `typical/campaign/<apply-id>/`.

## 10. Disclosures and risks
- **Model error is larger than the headroom.** The cap sits 1.2–2.1k statements from the modeled 700-rung start and end counts, and the candidate's leave-one-campaign-out RMSE is 1.4k–2.9k. A real count that is off by one RMSE can move the onset out of the 700 rung (to the 500 or 900 rung). The test is therefore a real test of the model, and a FAIL is a plausible outcome.
- **The tolerance is weak.** N = 34 polls (510 s) covers most of the 700 rung for every historical pattern, so it matters only near the rung's edges.
- **Breaches can interrupt the crossing.** pscap16k r1b was stopped 541 s into its 700 rung, 16 s after the modeled crossing poll for its pattern. A rep stopped before the crossing and before any 1461 is not assessable (§5.5 rule 4), and consumes a replacement.
- **Gap patterns beyond 700 are not used.** Only the 300, 500 and 700 rung offsets matter for the prediction. The 900 and later offsets are recorded but are inputs for a crossing only if the formula does not cross earlier.
- **Fit provenance:** the candidate was fit on the conn-2x-v1.1 and pscap16k-2x-v1 data, which were available before this prereg, and the gap patterns used to choose the cap come from the same campaigns. The cap itself is not a value in the fit data. The time term is an empirical curve, not a causal statement.
- **Connection estimates** are medians of earlier 2× runs. The 700 estimate (491) is itself near the 500 `max_connections` limit.
- The **ladder is reused**. It was not chosen independently for this question.
- **Publish scope:** only the prepared-statement count trajectory and the 1461 cap signal are publish candidates. Connection, TMC and breach predictions are **not** publish candidates from this campaign, whatever the outcome.
- `Threads_connected` includes non-app sessions such as the observer and rdsadmin. The fit used the same measurement, so no correction is applied.

## 11. Changelog
- **r1 (2026-10-27):** initial draft.
