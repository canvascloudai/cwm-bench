# cwm-bench `typical-dbsat-pscap-v1`: prepared-statement-cap holdout (4× m5.large, max_prepared_stmt_count = 65528), pre-registration

Status: **r1 draft, frozen on merge of this PR plus the wiring PR in §8** (whichever merges last). Nothing has been applied on AWS. Written 2026-10-17. Owner: Kevin Brown (holdout approved 2026-10-17).
This campaign is a **holdout** for the mechanism found in `typical-dbsat-v1` (results: `typical/dbsat-v1/results/discovery-20261016/`, PR #29). It is a separate campaign and is **never pooled** with dbsat-v1. Any change to §2–§7 after freeze means `typical-dbsat-pscap-v2`.

Labels follow dbsat-v1: **[FACT]** · **[DECISION]** · **[ASSUMPTION]** · **[DERIVED]** · **[OPEN]**.

---

## 0. Summary
In dbsat-v1 the 4× breaches (4× r1 at 700 RPS, 4× r2 at 500 RPS; all on the error criterion, `500/internal`) were not explained by the app pool, which had pool wait p95 under 0.1 ms and 0 queued. In a non-prereg 4× diagnostic, **`Prepared_stmt_count` reached the global `max_prepared_stmt_count` = 16,382 at 20:10 UTC 2026-10-16, in the same minute MySQL errno 1461 began.** The 1461 deltas were 4,476 / 5,722 / 6,297 / 6,090 / 2,087 over 20:10–20:14, and the breach was declared at 20:14:07. [FACT, PR #29 `diagnostic-4x-nonprereg/`]

This holdout changes **one thing**: the RDS parameter **`max_prepared_stmt_count = 65528`** (the MySQL maximum). Everything else is the dbsat-v1 4× configuration. If the cap is the mechanism, 1461 should disappear and the breach should move up the ladder (or vanish). If it is not, the breach stays at or below 700 RPS for another reason. The per-statement cause (which queries fill the cache) is **not** tested here. It stays unverified until endpoint-level errno exists.

## 1. Questions
- Q1 (scored, §6). With the cap raised to 65,528, do both 4× reps run without errno 1461 and breach above 700 RPS (or not at all)?
- Q2 (descriptive). Where does 4× break, on which criterion, and with what DB pressure (CPU, PI AAS and wait-class shares CPU/IO/lock, connections)? How does `Prepared_stmt_count` grow per rung?
- Q3 (descriptive, non-scored). Comparison with the cap-reached signal from Replit #5195.

## 2. Fixed topology (reused from dbsat-v1 §2) [FACT unless marked]
- us-east-2. Internal ALB. **4× m5.large** app servers on the same pinned AMI `ami-0d3d85815a9746bc5`. Node typical CRUD service, `app_workers=2`, per-node mysql2 pool 250, `queueLimit` 50 per worker.
- db.r5.large MySQL 8.0, single-AZ, gp2 100 GiB, `max_connections` 500, Performance Insights on. RDS engine pinned to `8.0.46-rds.20260908` (recorded per apply; a different version is a confound and is reported).
- c6i.xlarge k6 generator. **Generator arrangement and VU settings frozen as in dbsat-v1**: 1 generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`.
- **App and load code are byte-identical to measurement SHA `881e0cf`**: `app-typical/`, `load/typical.js`, `load/lib/`. Adapter 1.7.1, fresh seed per apply.
- **The only intervention [DECISION]**: the DB parameter group adds `max_prepared_stmt_count = 65528`. `max_connections` stays at 500.

## 3. Configuration, ladder and schedule
| Item | Value |
|---|---|
| Server count | 4× m5.large only |
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, ascending, no retries within an apply (dbsat-v1 §3) |
| Step | 5 min warmup + 15 min steady |
| Reps | **2 applies** (`r1`, `r2`), on 2 different UTC days where possible |
| Breach (dbsat-v1 §7.1, unchanged) | 3 consecutive one-minute steady windows each with error rate **> 5%** or P95 **> 2,000 ms**. Stop the step at the end of the 3rd minute and stop the sweep. The partial step is an "overload, N min" observation |
| Recovery (dbsat-v1 §7.2) | Run and recorded for evidence only. **Known artifact**: the idle baseline is 0 connections while the app pools keep connections open, so "recovery failed" on the connection rule is expected and carries no weight here. Nothing is planned on the stack after a breach |

## 4. Measurements
### 4.1 Reused from dbsat-v1 (§4, §6.0, scorer unchanged)
- Steady-window P95 (from raw k6 samples).
- Achieved RPS (from the raw k6 steady span).
- Error rate and classes from k6 `request_outcomes`.
- App CPU per node and generator validity.
- RDS CPU and DatabaseConnections.
- PI AAS and wait-class shares.
- Pool wait p95 and queue.
- ALB 5xx.

All are computed with `typical/dbsat-v1/score_dbsat_v1.py` (`record_from_collect`, `request_outcomes_from_k6`), with no change.

### 4.2 Diagnostic DB polling (new for this campaign; runner-side, no app/load change)
- Every **15 s**, from rung start through breach and destroy, on one extra **non-pooled, text-protocol** observer connection that creates no prepared statements, record:
  - `Prepared_stmt_count`
  - `max_prepared_stmt_count`
  - `Com_stmt_prepare`
  - `Com_stmt_close`
  - `Threads_connected`
  - the global error counter for **errno 1461** (`performance_schema.events_errors_summary_global_by_error`, `ER_MAX_PREPARED_STMT_COUNT_REACHED`), plus other changed error codes (descriptive).
- Report these per minute: min/max/last, and deltas assigned to the interval-end minute, as in the PR #29 diagnostic tables.
- **Continuous app logs** (journal capture of every app node) through the breach and until destroy, kept private, with counts reported.
- **Breach-time snapshot**: SHOW ENGINE INNODB STATUS plus the top-20 error summary, taken within 60 s of the breach declaration.
- If the app logs carry no errno, endpoint-level errno stays **unavailable**, and that is reported, not inferred.

## 5. Frozen predictions (written 2026-10-17, before any apply)
Evaluated **per rep**, with each rep's own breach rung B (B = "none" if all 7 rungs complete). "1461 total" is the sum of 1461 deltas over all rungs of that apply, including warmup and the partial breach step.

- **H1 — mechanism confirmed** if in **both** reps:
  1. 1461 total = 0 at every rung; **and**
  2. B > 700 (B ∈ {900, 1100, 1300, 1500, none}), above the dbsat-v1 4× breaches (500 and 700); **and**
  3. `Prepared_stmt_count` either **stabilizes below 65,528** (the last 5 samples of the final complete rung are all < 65,528), or **reaches 65,528 only at the breach step** (first sample at the cap falls inside the breach step).
- **H0 — mechanism rejected** if in **either** rep:
  - (a) B ≤ 700 with 1461 total = 0 (another cause breaks 4× at the same place); **or**
  - (b) any 1461 delta > 0 in a minute whose `Prepared_stmt_count` max is **below 58,975** (90% of 65,528), meaning 1461 appears well below the cap.
- **Mixed / not decided**: any other combination. Examples: H1 in one rep and neither H1 nor H0 in the other; B > 700 but 1461 > 0 at the cap before the breach step. All values are reported, and there is no retry to "settle" it.
- **Invalid rep** (not a result): diagnostic polling has more than 2 consecutive missing samples around the breach, or more than 10% missing overall; the parameter is not actually 65,528 at wait-ready (`SHOW GLOBAL VARIABLES`); or a dbsat-v1 §7.7 harness failure occurs. Invalid reps follow §7 replacement rules.
- Always reported descriptively, per rep and rung:
  - B and criterion (errors / P95)
  - steady P95, achieved RPS, error classes
  - DB CPU mean, PI AAS and CPU/IO/lock shares, max connections
  - `Prepared_stmt_count` trajectory
  - the comparison with the dbsat-v1 4× rungs (descriptive; never pooled).
- **Replit #5195 (non-scored comparison only; never enters H1/H0).**
  - **What it is:** an internal, opt-in, **uncalibrated projection**.
  - It computes **potential usage** = servers × pool size × `statementsPerConnection`, labelled the **full-pool upper bound**.
  - It computes an **open-connection estimate** = explicit open connections × `statementsPerConnection`.
  - At or above the cap (16,382 by default, configurable), it emits the signal **"prepared-statement cap reached"**: new prepares fail, while reuse may succeed.
  - It projects **no HTTP error rate**, and the signal is **invariant to RPS**.
  - **Comparison for pscap:** with the cap at 65,528, does the candidate signal stay off at the observed open connections, for any `statementsPerConnection` below 65,528 / 424 ≈ **154**? 424 is the highest DatabaseConnections seen in dbsat-v1; the comparison uses each rep's observed maximum.
  - We report the observed open connections, the implied `statementsPerConnection` (observed `Prepared_stmt_count` ÷ `Threads_connected`), and whether the projection's signal would be on or off at each rung, next to the observed 1461 counts.
  - Because the projection has no RPS dependence and no error rate, it cannot predict the breach rung.

## 6. Scoring
No new scorer. Per-rung records come from `score_dbsat_v1.record_from_collect` and `db_pressure`. H1/H0 is a lookup on the §4.2 tables using the rules in §5, and the evaluation script is committed with the results. There are no transitions and no §7.4 confirmation in this campaign.

## 7. Operations
### 7.1 Runner autonomy (the 2026-10-16 addendum from dbsat-v1, carried over)
- **Proceed without asking:**
  - Pre-workload failures with 0 rungs started: workspace restart, **readiness failure (including the app bootstrap seed race)**, AWS API timeout/throttle, capacity/launch errors, SSM/bootstrap transport failures. Destroy, verify cleanup, and retry the same apply **up to 2 times**. These retries are **not** replacements, and each is logged as a deviation with cause and UTC time.
  - Cleanup recovery (state reconciliation, import-to-destroy of verified orphans).
  - Valid data, meaning breaches, failed recoveries and partial steps: record them and continue in order.
  - Keep Terraform state and the console log on durable storage. After a restart, reconcile before any re-apply.
- **Proceed, then report:** harness-only fixes (collector, transport, monitor, cleanup, admission tooling) that don't touch app/load code, thresholds or scoring, provided the full suite passes. Record the old/new controller SHA256, the diff and the test results.
- **Stop and ask Kevin:**
  - any change to app/load code, the parameter value, this prereg, thresholds or scorer inputs;
  - a mid-workload harness failure that needs a replacement;
  - the same failure on 2 consecutive attempts, or a 3rd pre-workload retry;
  - projected or actual spend over the cap;
  - cleanup that cannot confirm no live resources in both regions.
- Send a short status after each apply.
- **Seed race: still deferred** (known issue from dbsat-v1). It is not fixed in this campaign. A readiness failure it causes is covered by the pre-workload retry rule above.

### 7.2 Budget and replacements
- **Soft cap $25** (spend-guard upper bound). At the cap, **pause and ask Kevin**; never auto-stop.
- **Up to 3 replacements**, only for measurement or harness failures, as in dbsat-v1 §7.7. At the cap, pause and ask.
- A workload breach or recovery failure is valid evidence and never authorizes a replacement.
- [DERIVED] 4× stack ≈ $0.87/h × ~3 h × 2 reps ≈ **$5.2**. Replacements ≤ 3 × ~$2.6 ≈ $7.8. Worst case ≈ $13, under $25.

## 8. Required changes before freeze (small, reviewed wiring PR; no app/load change)
1. **Terraform parameter group (needed).** In `terraform/rds.tf`, `resource "aws_db_parameter_group" "main"` today sets only `max_connections`. Add a variable `mysql_max_prepared_stmt_count` to `terraform/variables.tf`. Make its default **16382**, so all earlier campaigns are unchanged, and validate it to 0–65528. Add a second `parameter { name = "max_prepared_stmt_count", value = tostring(var.mysql_max_prepared_stmt_count) }` block, and expose the value in `terraform/outputs.tf` next to `mysql_max_connections`. The parameter is dynamic, so `apply_method` "immediate" is fine, and it is set at creation anyway. Applies pass `-var mysql_max_prepared_stmt_count=65528`. The wait-ready gate records `SHOW GLOBAL VARIABLES LIKE 'max_prepared_stmt_count'` = 65528.
2. **Adapter test id.** `DBSAT_TEST_ID_RE` in `scripts/lib/adapter/ladder.mjs` accepts only `typical-dbsat-{2x|3x|4x}-{r1|r2|c1|d1}[letter]-YYYYMMDD`. Extend it to accept `typical-dbsat-pscap-4x-r{1|2}[letter]-YYYYMMDD`, with a test, and keep the dbsat ladder and the 4× app count.
3. **Diagnostic controller (runner-side).** Fix and test the two known bugs before any paid apply:
   - (a) the breach hook's `diagnostic` identifier shadowed by a later local `const` in the same try block (temporal dead zone);
   - (b) aborted-rung preservation not finding `k6.json.gz` plus `exit.code` at the expected path, so the aborted rung's raw gzip was lost.

   Required offline tests:
   - a simulated breach captures the InnoDB/error snapshot;
   - an aborted rung keeps its original raw gzip.

   Record the new controller manifest SHA256, the diff and the test logs with the evidence.
4. Because items 1–2 change the repo, the infra/harness commit differs from 881e0cf. **The measurement content is unchanged by design**: the wiring PR must show `git diff 881e0cf -- app-typical/ load/` is empty. The evidence records both the wiring commit SHA and 881e0cf.

## 9. Names and paths
- `typical/dbsat-pscap-v1/PREREGISTRATION.md`
- Applies: `typical-dbsat-pscap-4x-r{1,2}[letter]-YYYYMMDD`
- Parent id: `typical-dbsat-pscap-v1-YYYYMMDD`
- Evidence: `typical/campaign/typical-dbsat-pscap-v1-<date>/`
- Results: `typical/dbsat-pscap-v1/results/`

## 10. Risks
- With 1461 removed, 4× may hit the next limit: `max_connections` 500 (pool fleet 1,000), DB CPU/IO, or app CPU. That is reported descriptively, and H0(a) applies only at B ≤ 700.
- A larger statement cache uses more server memory (each prepared statement holds parse state). This is reported via PI/CPU and not mitigated.
- Two reps may disagree. The result is then "mixed", reported as such, with no third rep.
- The recovery-rule artifact and the AAS window-end null bug from dbsat-v1 may recur. They are disclosed and not scored.

## 11. Changelog
- r1 (2026-10-17): initial draft.
- r1.1 (2026-10-17): §5 Replit #5195 comparison detail added (non-scored).
