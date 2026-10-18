# cwm-bench `typical-dbsat-conn-3x-v1`: MySQL server-limit holdout (3× m5.large, max_prepared_stmt_count = 65528, max_connections = 500), pre-registration

Status: **r1 draft, frozen on merge of this PR** (no wiring PR is required, see §8). Nothing has been applied on AWS. Written 2026-10-18. Owner: Kevin Brown (design approved 2026-10-18).

This campaign is a **holdout** for the recalibrated CWM server-limit candidate (unpublished, opt-in). That candidate was fitted only on 4× data (§5.1). It is a separate campaign and is **never pooled** with `typical-dbsat-v1` or `typical-dbsat-pscap-v1`. Any change to §2–§7 after freeze means `typical-dbsat-conn-3x-v2`.

Labels follow dbsat-v1: **[FACT]** · **[DECISION]** · **[ASSUMPTION]** · **[DERIVED]** · **[OPEN]**.

---

## 0. Summary
In `typical-dbsat-pscap-v1` (results: `typical/dbsat-pscap-v1/results/holdout-20261017/`), raising `max_prepared_stmt_count` to 65,528 removed errno 1461 on 4× and moved the breach from 500/700 to 900 RPS. Both reps then broke on the MySQL server-wide connection limit: `503/too_many_connections`, errno 1040, and `Threads_connected` pinned at 503 against `max_connections` 500. [FACT]

The recalibrated CWM server-limit candidate (unpublished, opt-in) was fitted on that 4× data. It predicts where a **smaller** topology hits the same server limit. This holdout changes **one thing** relative to pscap-v1: **3 app servers instead of 4**. With 3 × 250 pool connections (750) against a 500 server limit, the candidate predicts the following for this campaign:
- the first binding limit is the DB server's `max_connections`;
- an error-rate breach at about 675 total RPS (225 per server), so the **700** rung on the ladder;
- 500-connection saturation at about 525 RPS;
- the prepared-statement cap is never reached.

## 1. Questions
- **Q1 (scored, §6).** On 3× with `max_prepared_stmt_count` 65,528 and `max_connections` 500, do both reps first breach at the 700 rung, on the error criterion, dominated by `503/too_many_connections`, with zero errno 1461?
- **Q2 (descriptive).** How do server connections, `Prepared_stmt_count`, statements per connection, DB CPU/AAS and error classes evolve per rung on 3×, and how do they compare with pscap-v1 4× (descriptive, never pooled)?

## 2. Fixed topology (reused from pscap-v1 §2 except the app count) [FACT unless marked]
- us-east-2. Internal ALB. **3× m5.large** app servers on the same pinned AMI `ami-0d3d85815a9746bc5`. Node typical CRUD service, `app_workers=2`, per-node mysql2 pool 250 (fleet 750), `queueLimit` 50 per worker.
- db.r5.large MySQL 8.0, single-AZ, gp2 100 GiB, Performance Insights on. RDS engine pinned to `8.0.46-rds.20260908` (recorded per apply; a different version is a confound and is reported).
- c6i.xlarge k6 generator. **Generator arrangement and VU settings frozen as in dbsat-v1**: 1 generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`.
- **App and load code are byte-identical to measurement SHA `881e0cf`**: `app-typical/`, `load/typical.js`, `load/lib/`. Adapter 1.7.1, fresh seed per apply.
- **DB parameters (unchanged from pscap-v1) [DECISION]:**
  - `max_prepared_stmt_count = 65528`, via `-var mysql_max_prepared_stmt_count=65528`.
  - `max_connections = 500`, set in the DB parameter group via the Terraform `mysql_max_connections` variable (default 500).
  - 500 is a declared parameter-group override, not the RDS formula default for this class. The formula `DBInstanceClassMemory/12582880` gives about 1,365 on db.r5.large; see `terraform/variables.tf`.
  - Both actual values are recorded at wait-ready with `SHOW GLOBAL VARIABLES` (§4.2).
- **The only intervention vs pscap-v1 [DECISION]:** app server count 4 → 3.

## 3. Configuration, ladder and schedule
| Item | Value |
|---|---|
| Server count | 3× m5.large only |
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, ascending, no retries within an apply (dbsat-v1 §3) |
| Step | 5 min warmup + 15 min steady |
| Reps | **2 applies** (`r1`, `r2`). Each is a fresh apply with no stack reuse. **Running both on the same UTC day is allowed and is disclosed in the results** |
| Breach (dbsat-v1 §7.1, unchanged) | 3 consecutive one-minute steady windows each with error rate **> 5%** or P95 **> 2,000 ms**. Stop the step at the end of the 3rd minute and stop the sweep. The partial step is an "overload, N min" observation |
| Recovery (dbsat-v1 §7.2) | Run and recorded for evidence only. **Known artifact**: the idle baseline is 0 connections while the app pools keep connections open, so "recovery failed" on the connection rule is expected and carries no weight. Nothing is planned on the stack after a breach |

## 4. Measurements
### 4.1 Reused from dbsat-v1 and pscap-v1 (scorer unchanged)
- Steady-window P95 from raw k6 samples (nearest rank), with phase=steady P95 reported alongside.
- Achieved RPS (from the raw k6 steady span).
- Error rate and classes from k6 `request_outcomes` (phase=steady).
- App CPU per node and generator validity.
- RDS CPU and DatabaseConnections.
- PI AAS and wait-class shares.
- Pool wait p95 and queue.
- ALB 5xx.

All are computed with `typical/dbsat-v1/score_dbsat_v1.py` (`record_from_collect`, `request_outcomes_from_k6`, `steady_span_from_k6`, `db_pressure`), with no change. Per-rung records use the pscap-v1 `build_records.py` pattern.

### 4.2 Diagnostic DB polling (as pscap-v1 §4.2)
- At wait-ready, record `SHOW GLOBAL VARIABLES` for `max_prepared_stmt_count` (must be 65528) and `max_connections` (actual value recorded; expected 500).
- Every **15 s**, from rung start through breach and destroy, on one extra **non-pooled, text-protocol** observer connection that creates no prepared statements, record:
  - `Prepared_stmt_count`
  - `max_prepared_stmt_count`
  - `Com_stmt_prepare`
  - `Com_stmt_close`
  - `Threads_connected`
  - the global error counters from `performance_schema.events_errors_summary_global_by_error`: **errno 1461** (`ER_MAX_PREPARED_STMT_COUNT_REACHED`) and **errno 1040** (`ER_CON_COUNT_ERROR`), plus other changed codes (descriptive).
- Report per minute: min/max/last, and deltas assigned to the interval-end minute. Report per rung: 1461 and 1040 deltas, `Prepared_stmt_count` peak and last 5 samples, `Threads_connected` max. The pscap-v1 `build_rung_tables.py` pattern applies.
- **Continuous app logs** (journal capture of every app node) through the breach and until destroy, kept private, with counts reported.
- **Breach-time snapshot**: SHOW ENGINE INNODB STATUS plus the top-20 error summary, taken within 60 s of the breach declaration.
- Endpoint-level errno stays **unavailable** unless the app logs carry it, and that is reported, not inferred.
- CloudWatch `DatabaseConnections` is descriptive only. **Server connections for scoring are `Threads_connected` from the observer polls.** In pscap-v1, CloudWatch read 570 while the server read 503.

## 5. Frozen predictions (written 2026-10-18, before any apply)

### 5.1 Locked candidate: the recalibrated CWM server-limit candidate (unpublished, opt-in)
- **Status.** The candidate is not enabled in normal CWM runs and is not published. Its predictions are frozen here before any 3× apply. **No accuracy claim is made for it in this prereg or before this holdout is scored.**
- **Engine commit:** `56001ba1ee0534e0523aeae3912f8b2b0d1abdb5`. This is the recalibrated CWM server-limit candidate code that produced the frozen predictions in this section.
- **Fit inputs:** these per-minute diagnostic CSVs only.
  - pscap-v1 holdout r1 and r2: `prepared-statements-by-minute.csv`, `mysql-errors-by-minute.csv`, `http-outcomes-by-minute.csv`.
  - The dbsat-v1 non-prereg 4× diagnostic: `prepared-statements-by-minute.csv`, `prepared-limit-and-1461-by-minute.csv`, `mysql-errors-by-minute.csv`, `http-outcomes-all-rungs-by-minute.csv`.
  - **All fit data is 4×.** No 2× or 3× run is a fit input.

**Fitted coefficients (frozen):**
| Fit | Value | Derivation (summary) |
|---|---:|---|
| Statements per open server connection, dbsat-v1 4× diagnostic | **49.056820** | OLS through the origin, `Prepared_stmt_count_last = k × threadsMax`, 82 minute rows. 16,382 / k = 334 connections |
| Statements per open server connection, pscap-v1 4× high-load plateau | **59.102686** | OLS through the origin on 8 complete high-load minutes (r1 18:12–18:15 UTC, r2 21:31–21:34 UTC), `threadsMax` 501–503. At 500 connections: 29,551 |
| `too_many_connections` share above the server limit, pscap-v1 4× | **15.350501%** | 64,277 / 418,729 outcomes over the same 8 minutes |
| Candidate error-rate threshold | **1%** | The share is applied only above 500 server connections and when it exceeds 1% |

**Per-server connection knots (frozen, piecewise-linear, x = offered RPS per app server, y = median `Threads_connected`):**
| Curve | Knots (RPS/server, connections) | Notes |
|---|---|---|
| pscap-v1 (65,528 cap) | (75, 131), (125, 328.5), (175, 500), (225, 503) | Mean of r1/r2 rung medians. Fitted `too_many_connections` share is 0.3251% at 175 and 15.3505% at 225. The first knot above the 1% threshold is **225 RPS/server** (the error-rate breach rung). The 500-connection saturation point is 175 RPS/server |
| dbsat-v1 4× diagnostic (16,382 cap) | (75, 97), (125, 173), (175, 397) | 334 connections inverts to 160.9375 RPS/server |

**Frozen topology breakpoint matrix (candidate output, verbatim):**
| App servers | App-pool capacity | `max_prepared_stmt_count=16,382`: first limit | Offered RPS | Server connections | `max_prepared_stmt_count=65,528`: first limit | Offered RPS | Server connections | 500-connection saturation RPS |
|---:|---:|---|---:|---:|---|---:|---:|---:|
| 2× | 500 | Prepared-statement cap | 321.9 | 334 | DB max connections (first error-rate breach rung) | 450 | 503 | 350 |
| **3×** | **750** | Prepared-statement cap | 482.8 | 334 | **DB max connections (first error-rate breach rung)** | **675** | **503** | **525** |
| 4× | 1,000 | Prepared-statement cap | 643.8 | 334 | DB max connections (first error-rate breach rung) | 900 | 503 | 700 |

With the 65,528 cap, the pscap coefficient puts the prepared-statement boundary at about 1,109 connections, above the 500 server limit, so the cap is never the first limit. The 2× and 3× rows are extrapolations of the fitted per-server rungs. Only the **3× / 65,528** row is tested here.

### 5.2 Mapping to the ladder [DERIVED, frozen]
- Predicted error-rate breach at 675 total RPS (225/server). The first ladder rung at or above 675 is **700** (233.3/server). **Predicted breach rung B\* = 700.**
- Predicted 500-connection saturation at 525 RPS (175/server), between the 500 and 700 rungs. At the 500 rung the candidate is below saturation and has no fitted error share, so it predicts no breach at 500.
- The candidate threshold (1%) differs from the campaign breach criterion (>5% for 3 consecutive minutes). Above the server limit the fitted share is 15.35%, which exceeds both, so the mapping to B\* = 700 does not depend on that difference. [DERIVED]
- Reference values derived from the frozen knots by linear interpolation. These are not scored:

  | Rung | RPS/server | Predicted server connections | Predicted `Prepared_stmt_count` (59.102686/conn) |
  |---|---:|---:|---:|
  | 300 | 100.0 | 229.8 | ~13,600 |
  | 500 | 166.7 | 471.4 | ~27,900 |
  | 700 | 233.3 | at the 500 ceiling (503 at the error rung) | ~29,600 (29,551 at 500; 29,729 at 503) |

### 5.3 Hypotheses (per rep, then campaign)
Evaluated **per rep**, with each rep's own first breach rung B (B = "none" if all 7 rungs complete).

Definitions:
- **1461 total** is the sum of errno 1461 deltas over all rungs of that apply, warmup and the partial breach step included.
- **TMC share** is computed over steady-phase k6 `request_outcomes` at the breach rung. It is the count with class `too_many_connections` (HTTP 503) divided by all failure points at that rung. Failure points have HTTP status ≥ 400 or 0, classed as in `request_outcomes_from_k6`.
- **Server-limit reached** means max `Threads_connected` ≥ 0.98 × the recorded `max_connections`, which is 490 at 500. It is measured in any 15 s sample from the start of the first rung through the breach declaration.

- **H1, per rep (pass).** All of the following hold:
  1. B = 700, the first breach, with no breach at 300 or 500;
  2. the breach is on the **error criterion**: error rate > 5% in each of the 3 breach minutes;
  3. **TMC share > 50%** at the breach rung;
  4. 1461 total = 0;
  5. server-limit reached at or before the 700 rung;
  6. every `Prepared_stmt_count` sample in the apply is < 65,528.
- **H0, per rep (fail).** Any of the following:
  - (a) B ≤ 500 (a breach at 300 or 500);
  - (b) no breach at 700: B ∈ {900, 1100, 1300, 1500, none}. **A breach at 900 is a clear miss.** It would be consistent with the candidate undercounting the per-server capacity of smaller topologies, because its per-server rungs were fitted on 4× only;
  - (c) B = 700 but the mechanism is not connections: TMC share ≤ 50%, or the server limit was not reached at or before 700;
  - (d) any 1461 delta > 0 in the apply;
  - (e) any `Prepared_stmt_count` sample ≥ 65,528. This is contrary to the locked "never reached" prediction.
- **Per-rep mixed.** Any other combination counts as mixed. The one case named in advance: B = 700 on the P95 criterion only (error rate ≤ 5% in at least one breach minute), with TMC share > 50% and the server limit reached. All values are reported.
- **Campaign verdict:**
  - **H1** if both valid reps are H1.
  - **H0** if both valid reps are H0.
  - **Not decided** otherwise: a rep is invalid after the replacement rules (§7.2) are exhausted or not run, the reps disagree (for example H1 and H0), or either rep is mixed.
  - There is no third rep to "settle" a disagreement.

### 5.4 Rep validity (written in advance; replaces the pscap-v1 ad-hoc exception)
**Verdict-bearing evidence (E).** These are the only inputs to §5.3:
- **E1** — wait-ready `SHOW GLOBAL VARIABLES`: `max_prepared_stmt_count` = 65528, and the actual value of `max_connections`.
- **E2** — the breach-monitor per-minute rows for every rung through the breach declaration, or through the last rung if there is no breach.
- **E3** — the raw k6 `k6.json.gz` for every rung through the breach rung, hash-verified against the generator transfer before destroy. The 1/2/3 consecutive-minute P95 and error values and the steady `request_outcomes` are recomputable from it.
- **E4** — the 15 s observer polls, with ≤ 2 consecutive missing samples from the breach-rung start through declaration + 60 s, and ≤ 10% missing from the first rung start through declaration + 60 s.
- **E5** — generator validity (dbsat-v1 §7.5) on every rung before the breach rung. On the breach rung, dropped iterations must be ≤ 0.5% of scheduled, from the collect, or from the raw k6 `dropped_iterations` if the collect is missing.

A rep is **invalid** (not a result; it follows the §7.2 replacement rules) if any of the following holds:
- any of E1–E5 is missing or fails;
- `max_prepared_stmt_count` ≠ 65528 at wait-ready;
- `max_connections` ≠ 500 at wait-ready. Another value changes the tested condition, and the rep is reported but not scored;
- a measurement, harness or infrastructure failure **starts before the breach declaration**, or before the last rung completes if there is no breach.

**Harness failure after the breach (pre-registered rule).** A harness or infrastructure failure whose recorded start time is **after the breach declaration timestamp** does **not** invalidate the rep, provided E1–E5 are intact. This covers, for example, collect processing or boundary persistence failing after the stop. In that case:
- data that depends on the failed step (the live collect's CloudWatch/PI/pool aggregates, recovery) is reported as **unavailable**, never reconstructed;
- the breach rung's P95 and outcomes come from the preserved raw k6 using the pinned steady script, and are labelled as offline;
- the failure record (timestamp, stage, message) is kept unmodified in the evidence.

No rerun of that rep is made, and no owner exception is needed. Whether a failure is before or after the breach is decided only by comparing the controller's recorded failure timestamp with the breach-monitor declaration timestamp.

## 6. Scoring
No new scorer. Per-rung records come from `score_dbsat_v1.record_from_collect` and `db_pressure`, and the §4.2 tables from the observer polls. H1/H0 is a lookup on those tables and the steady k6 outcomes using §5.3 and §5.4, by an evaluation script committed with the results. It follows the pscap-v1 `evaluate_pscap_v1.py` pattern and adds the TMC-share and server-limit conditions. There are no transitions and no §7.4 confirmation in this campaign.

**Post-hoc comparison, not preregistered and not part of the H1/H0 test.** The candidate's 16,382-cap predictions for 2× (321.9 RPS) and 3× (482.8 RPS) are **lower** than the `typical-dbsat-v1` discovery measurements. Those measurements (`typical/dbsat-v1/results/discovery-20261016/records.json`) are:
- 2× breached at 500 (r1) and 700 (r2);
- 3× breached at 900 (r1) and 700 (r2).

All four breaches were on the error criterion, on `500/internal`. Those 2× and 3× runs were **not** fit data for the candidate. This is disclosed now because it was noticed before freeze. It is reported descriptively with the results and does not change any prediction above.

## 7. Operations
### 7.1 Runner autonomy (the 2026-10-16 addendum from dbsat-v1, as carried over in pscap-v1)
- **Proceed without asking:**
  - Pre-workload failures with 0 rungs started: workspace restart, readiness failure (including the app bootstrap seed race), AWS API timeout/throttle, capacity/launch errors, SSM/bootstrap transport failures. Destroy, verify cleanup, and retry the same apply **up to 2 times**. These retries are **not** replacements, and each is logged as a deviation with cause and UTC time.
  - Cleanup recovery (state reconciliation, import-to-destroy of verified orphans).
  - Valid data, meaning breaches, failed recoveries and partial steps: record them and continue in order.
  - **A harness failure after the breach declaration with E1–E5 intact (§5.4):** preserve the evidence, destroy, verify cleanup, record it, and continue to the next rep. No replacement is made.
  - Keep Terraform state and the console log on durable storage. After a restart, reconcile before any re-apply.
- **Proceed, then report:** harness-only fixes (collector, transport, monitor, cleanup, admission tooling) that don't touch app/load code, thresholds or scoring, provided the full suite passes. Record the old/new controller SHA256, the diff and the test results.
- **Stop and ask Kevin:**
  - any change to app/load code, the parameter values, this prereg, thresholds or scorer inputs;
  - a failure before the breach declaration that needs a replacement;
  - the same failure on 2 consecutive attempts, or a 3rd pre-workload retry;
  - projected or actual spend over the cap;
  - cleanup that cannot confirm no live resources in both regions.
- Send a short status after each apply.
- **Seed race: still deferred** (known issue from dbsat-v1). It is covered by the pre-workload retry rule above.

### 7.2 Budget and replacements
- **Soft cap $25** (spend-guard upper bound). At the cap, **pause and ask Kevin**; never auto-stop.
- **Up to 3 replacements**, only for invalid reps (§5.4), as in dbsat-v1 §7.7. At the cap, pause and ask. Replacements use the next letter suffix (`r1a`, `r1b`, …).
- A workload breach or recovery failure is valid evidence and never authorizes a replacement. Neither does a post-breach harness failure with E1–E5 intact.
- [DERIVED] Spend estimate:
  - pscap-v1 spent an upper bound of **$4.42** for 2 reps on 4× (4 rungs each).
  - 3× has one fewer app node, and the predicted breach at 700 means about 3 rungs per rep, so the estimate is **≈ $4–5 for 2 reps**.
  - Replacements cost ≤ 3 × ~$2.5 ≈ $7.5.
  - Worst case ≈ $13, under $25.

### 7.3 Cleanup and redaction (as pscap-v1)
- Destroy after each apply. Run immediate and ≥ 15-minute delayed cleanup checks in us-east-2 and us-west-2.
- Before publication, the evidence archive is redacted as in `typical/dbsat-pscap-v1/results/holdout-20261017/REDACTION.md`:
  - account ID and ARNs;
  - public IPs;
  - RDS endpoint hash and resource IDs;
  - ALB DNS numbers;
  - EC2 instance and volume IDs, including in file and directory names;
  - SSM command IDs;
  - runner paths.
- The redacted derivative gets new hashes, and the private original's SHA256 is recorded. Raw k6 gzips stay off-repo.

## 8. Required changes before the first apply (no app/load change)
1. **Repo wiring: none required [FACT, checked against `main` @ a30113d4].**
   - Apply IDs reuse the existing pscap ID family (§9), which the adapter already accepts for the 3× dbsat keys: `DBSAT_PSCAP_TEST_ID_RE` / `DBSAT_TEST_ID_RE` in `scripts/lib/adapter/ladder.mjs`, scale 3x, `expectedAppCount` 3.
   - The wait-ready gate already enforces `max_prepared_stmt_count = 65528` for that family (`scripts/lib/adapter/ready.mjs`).
   - The Terraform `mysql_max_prepared_stmt_count` variable exists, and `mysql_max_connections` (default 500) sets `max_connections` in the DB parameter group.
   - The 3× scenario keys `typical-dbsat-3x-{300…1500}` exist.
2. **Runner-side controller (not in this repo).** Start from the pscap-v1 rep 2 controller (pscap-1.0.1-boundaries, controller SHA256 `d27be406bdf19b689b0f7dde86d8c29b76d0716da36fcf79d4a9292c905ee5f0`). It includes the post-breach boundary reread. Before any paid apply:
   - (a) accept the 3× app count and the §9 IDs;
   - (b) record `max_connections` at wait-ready;
   - (c) record the failure timestamp and stage in every problem record, so §5.4 can be applied mechanically;
   - (d) compute TMC share at the breach rung in the run summary (descriptive; scoring recomputes it).

   Required offline tests: a simulated 3× breach captures the InnoDB/error snapshot; an aborted rung keeps its original raw gzip; a simulated post-breach processing failure produces a timestamped problem record with E1–E5 intact. Record the new controller manifest SHA256, the diff and the test logs with the evidence.
3. The wiring commit is `main` at freeze, with `git diff 881e0cf -- app-typical/ load/` empty. The evidence records both that commit and 881e0cf.

## 9. Names and paths
- `typical/dbsat-conn-3x-v1/PREREGISTRATION.md`
- Applies: `typical-dbsat-pscap-3x-r{1,2}[letter]-YYYYMMDD`. This reuses the pscap ID family because it carries the 65,528 parameter gate. pscap-v1 used only 4×, so the 3× IDs cannot collide with it.
- Parent ID: `typical-dbsat-conn-3x-v1-YYYYMMDD`
- Evidence: `typical/campaign/typical-dbsat-conn-3x-v1-<date>/`
- Results: `typical/dbsat-conn-3x-v1/results/`

## 10. Risks
- On 3×, 700 RPS is 233 RPS per server. That is above pscap-v1's highest per-server load that stayed below breach (175 at 4× 700). The app tier (CPU, event loop, queueLimit) could become the first limit instead. That would show as a non-connection mechanism, H0(c), or a P95-only breach (mixed), and is reported descriptively.
- If the 3× pool fleet (750) does not push the server to 500 before 700, the breach could move to 900, H0(b).
- Reps may disagree, as pscap-v1 4× did in severity at 700. The result is then "not decided", with no third rep.
- The recovery-rule artifact and the AAS window-end null bug may recur. They are disclosed and not scored.

## 11. Changelog
- r1 (2026-10-18): initial draft.
- r1.1 (2026-10-18, before freeze): engine commit recorded (§5.1); `max_connections` wording clarified as the parameter-group setting (§2, §8). No change to predictions, hypotheses or rules.
