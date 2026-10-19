# cwm-bench `typical-dbsat-conn-2x-v1`: MySQL server-limit holdout for the refit candidate (2× m5.large, max_prepared_stmt_count = 65528, max_connections = 500), pre-registration

Status: **r1 draft, frozen on merge of this PR** (no repo wiring is required, see §8). Nothing has been applied on AWS. Written 2026-10-18. Owner: Kevin Brown.

This campaign is a **holdout** for the refit CWM server-limit candidate (unpublished, opt-in), engine commit `ffda3ebaae13755ec0a7e5264f90cc5ac480e311`. It is a separate campaign and is **never pooled** with `typical-dbsat-v1`, `typical-dbsat-pscap-v1` or `typical-dbsat-conn-3x-v1`. Any change to §2–§7 after freeze means `typical-dbsat-conn-2x-v2`.

Labels follow dbsat-v1: **[FACT]** · **[DECISION]** · **[ASSUMPTION]** · **[DERIVED]** · **[OPEN]**.

---

## 0. Summary
- `typical-dbsat-pscap-v1` (4×) and `typical-dbsat-conn-3x-v1` (3×) both ran with `max_prepared_stmt_count` 65,528 and `max_connections` 500. In both, every rep first breached at the **900** rung, dominated by `503/too_many_connections`, with zero errno 1461. [FACT; results in `typical/dbsat-pscap-v1/results/holdout-20261017/` and `typical/dbsat-conn-3x-v1/results/holdout-20261018/`]
- The earlier candidate (engine commit `56001ba1…`, conn-3x §5.1) modelled connections per app server and predicted a 3× breach at the 700 rung. The 3× holdout rejected that prediction (H0, both reps H0(b)). That prediction and its result stay on record unchanged.
- The **refit** candidate was refitted on the pscap-v1 and conn-3x data (§5.1). It models server connections as a function of **total** offered RPS, not RPS per server. This holdout changes **one thing** relative to conn-3x: **2 app servers instead of 3** (pool fleet 2 × 250 = 500). With one ordinary observer connection, the candidate predicts:
  - the first binding limit is DB server admission (`max_connections`);
  - the first tested-ladder conditional error breach is at **900** RPS (rung 4);
  - an interpolated 5% error crossing at **771.78** RPS and server saturation at about **802** RPS;
  - the prepared-statement cap is never reached.
- The candidate models **only** `too_many_connections` rejections. It does not model latency or any other error class (§5.1).

## 1. Questions
- **Q1 (scored, §6).** On 2× with `max_prepared_stmt_count` 65,528 and `max_connections` 500, does each rep first breach at the 900 rung, on the error criterion, dominated by `503/too_many_connections`, with the server limit reached, zero errno 1461 and the prepared cap not reached?
- **Q2 (descriptive).** How do server connections, `Prepared_stmt_count`, statements per connection, DB CPU/AAS, app CPU and error classes evolve per rung on 2×? How do they compare with the frozen §5.2 matrix and with conn-3x 3× and pscap-v1 4× (descriptive, never pooled)?

## 2. Fixed topology (reused from conn-3x §2 except the app count) [FACT unless marked]
- us-east-2. Internal ALB. **2× m5.large** app servers on the same pinned AMI `ami-0d3d85815a9746bc5`. Node typical CRUD service, `app_workers=2`, per-node mysql2 pool 250 (fleet **500**), `queueLimit` 50 per worker.
- db.r5.large MySQL 8.0, single-AZ, gp2 100 GiB, Performance Insights on. RDS engine pinned to `8.0.46-rds.20260908` (recorded per apply; a different version is a confound and is reported).
- c6i.xlarge k6 generator. **Generator arrangement and VU settings frozen as in dbsat-v1**: 1 generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`.
- **App and load code are byte-identical to measurement SHA `881e0cf`**: `app-typical/`, `load/typical.js`, `load/lib/`. Adapter 1.7.1, fresh seed per apply.
- **DB parameters (unchanged from conn-3x) [DECISION]:**
  - `max_prepared_stmt_count = 65528`, via `-var mysql_max_prepared_stmt_count=65528`.
  - `max_connections = 500`, set in the DB parameter group via the Terraform `mysql_max_connections` variable (default 500). This is a declared parameter-group override, not the RDS formula default for this class (about 1,365 on db.r5.large; see `terraform/variables.tf`).
  - Both actual values are recorded at wait-ready with `SHOW GLOBAL VARIABLES` (§4.2).
- **The only intervention vs conn-3x [DECISION]:** app server count 3 → 2. At 2× the app-pool fleet (500) equals the server limit (500), so which side binds first depends on observer/system connections (§5.1, §5.2).

## 3. Configuration, ladder and schedule
| Item | Value |
|---|---|
| Server count | 2× m5.large only |
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, ascending, no retries within an apply (dbsat-v1 §3). One-based rung index: 300 = 1 … 1500 = 7 |
| Step | 300 s linear warmup (0 → target) + 900 s steady; 1,200 s planned elapsed; full-target-equivalent work = RPS × 1,050 s |
| Reps | **2 applies** (`r1`, `r2`). Each is a fresh apply with no stack reuse. **Running both on the same UTC day is allowed and is disclosed in the results** |
| Breach (§3.1) | 3 consecutive complete steady minutes, each with error rate > 5% or P95 > 2,000 ms |
| Recovery (dbsat-v1 §7.2) | Run and recorded for evidence only. **Known artifact**: the idle baseline is 0 connections while the app pools keep connections open, so "recovery failed" on the connection rule is expected and carries no weight. Nothing is planned on the stack after a breach |

### 3.1 Breach rule (written out in full; adopted prospectively) [DECISION]
- **Eligible minute:** a full UTC minute `[start, end)` that lies entirely inside `phase=steady`. A missing or incomplete minute is not eligible and **breaks the streak**.
- **Minute condition:** error rate > 0.05 **or** nearest-rank HTTP P95 > 2,000 ms, where **error rate = all HTTP failure responses / all HTTP responses** in that minute. Failure responses have status ≥ 400 or 0, classed as in `request_outcomes_from_k6`. Equality is not a breach (strictly greater than).
- **Breach:** 3 consecutive eligible minutes that each meet the minute condition (OR within a minute, AND across the 3 minutes). Stop the rung and the upward sweep at the end of the third qualifying minute. The partial step is an "overload, N min" observation. A breach during warmup does not count.
- This is the dbsat-v1 §7.1 rule with the minute eligibility and the error denominator stated explicitly. It is not a change of threshold.

## 4. Measurements
### 4.1 Reused from dbsat-v1, pscap-v1 and conn-3x (scorer unchanged)
- Steady-window P95 from raw k6 samples (nearest rank), with phase=steady P95 reported alongside.
- Achieved RPS (from the raw k6 steady span).
- Error rate and classes from k6 `request_outcomes` (phase=steady).
- App CPU per node and generator validity.
- RDS CPU and DatabaseConnections.
- PI AAS and wait-class shares.
- Pool wait p95 and queue.
- ALB 5xx.

All are computed with `typical/dbsat-v1/score_dbsat_v1.py` (`record_from_collect`, `request_outcomes_from_k6`, `steady_span_from_k6`, `db_pressure`), with no change. Per-rung records and tables use the conn-3x `build_records.py` / `build_rung_tables.py` pattern.

### 4.2 Diagnostic DB polling (as conn-3x §4.2)
- At wait-ready, record `SHOW GLOBAL VARIABLES` for `max_prepared_stmt_count` (must be 65528) and `max_connections` (must be 500).
- Every **15 s**, from rung start through breach and destroy, on one extra **non-pooled, text-protocol** observer connection that creates no prepared statements, record:
  - `Prepared_stmt_count`
  - `max_prepared_stmt_count`
  - `Com_stmt_prepare`
  - `Com_stmt_close`
  - `Threads_connected`
  - the global error counters from `performance_schema.events_errors_summary_global_by_error`: **errno 1461** (`ER_MAX_PREPARED_STMT_COUNT_REACHED`) and **errno 1040** (`ER_CON_COUNT_ERROR`), plus other changed codes (descriptive).
- Report per minute: min/max/last, and deltas assigned to the interval-end minute. Report per rung: 1461 and 1040 deltas, `Prepared_stmt_count` peak and last 5 samples, `Threads_connected` max and the median of complete-steady-minute maxima (the candidate's connection measure, §5.1).
- **Continuous app logs** (journal capture of every app node) through the breach and until destroy, kept private, with counts reported.
- **Breach-time snapshot**: SHOW ENGINE INNODB STATUS plus the top-20 error summary, taken within 60 s of the breach declaration.
- Endpoint-level errno stays **unavailable** unless the app logs carry it, and that is reported, not inferred.
- CloudWatch `DatabaseConnections` is descriptive only. **Server connections for scoring are `Threads_connected` from the observer polls.**

## 5. Frozen predictions (written 2026-10-18, before any apply)

### 5.1 Locked candidate: the refit CWM server-limit candidate (unpublished, opt-in)
- **Status.** The candidate is not enabled in normal CWM runs and is not published. Its predictions are frozen here before any 2× apply. **No accuracy claim is made for it in this prereg or before this holdout is scored.**
- **Engine commit:** `ffda3ebaae13755ec0a7e5264f90cc5ac480e311`. This commit produced the frozen values in §5.1–§5.2, which are reproduced verbatim from the candidate's output (rounded only where shown).
- **Provenance and fit data [FACT].**
  - Fit inputs are the per-minute diagnostics of **pscap-v1 holdout r1/r2 (4×)** and **conn-3x holdout r1/r2 (3×)**, the latter as merged at `typical/dbsat-conn-3x-v1/results/holdout-20261018/`. Both campaigns are therefore **fit data for this version** and cannot count as evidence for it.
  - **No 2× run is a fit input.** The `typical-dbsat-v1` 2× discovery runs (16,382 cap) were not used.
  - The prior candidate (engine commit `56001ba1ee0534e0523aeae3912f8b2b0d1abdb5`) and its failed 3× prediction remain on record in `typical/dbsat-conn-3x-v1/`. For reference only, its frozen 2× / 65,528 row predicted a first error-rate breach at 450 RPS (conn-3x §5.1). That row is not tested or rescored here.
- **Model form (frozen).**
  - **Connection demand** (total server connections, observer included): `exp(5.504792463336661) × (totalRps / 500)^1.5009256881214468`, which is 245.867 at 500 RPS. It is a function of **total** RPS. A topology term was considered and rejected by a leave-one-rep-out rule (topology effect fixed at 0). Connections are measured as the median over complete steady minutes of the per-minute `Threads_connected` maximum. The fit uses 10 rung observations.
  - **Leave-rep sensitivity fits** (n = 5 each; sensitivity ranges, **not** confidence intervals): (log-connections at 500, exponent) = (5.539149120254926, 1.237555146716952) and (5.470435806418398, 1.7642962295259454).
  - **Admission:** the app's attempted demand is the connection demand minus observer/system connections. Admitted app connections are capped by the app pool (500) and by the server ceiling (500 minus ordinary observer/system connections).
  - **`too_many_connections` share** (TMC count / **all** HTTP responses over complete steady minutes), piecewise-linear by total RPS, applied only when server admission binds. Above 900 it is held at the last knot:

    | Total RPS | Share | Min rep | Max rep |
    |---:|---:|---:|---:|
    | 300 | 0 | 0 | 0 |
    | 500 | 0 | 0 | 0 |
    | 700 | 0.0018212181408681157 | 0 | 0.007281470676445729 |
    | 900 | 0.13606087522079935 | 0.09411478902191381 | 0.17696397441544504 |

  - **Prepared statements:** 59.10268577018286 per open server connection, applied once to the total open connections (app + observer/system). The observer creates no statements.
  - **Restrictions (stated by the candidate).** TMC alone is a lower bound on total errors. **Latency and non-TMC errors are not modelled**, so the candidate's breach is a *conditional* error breach (conditional on server admission causing rejections). Above 900 RPS all values are extrapolations, with no measurement of the shape beyond the stop. The 2× transfer of the total-RPS demand curve is itself an extrapolation.

### 5.2 Frozen primary matrix (scored assumption: one ordinary observer)
Assumption: 1 ordinary observer/system connection, 0 exempt. App pool ceiling 500; effective server app ceiling 499. Counts are fractional model estimates, not measured samples. "TMC %" is TMC / all HTTP responses.

| Rung | Total RPS | Attempted app demand | Admitted app | Total open | Prepared | TMC % | Server / pool saturated | Conditional breach |
|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 300 | 113.215 | 113.215 | 114.215 | 6,750.403 | 0.00000 | no / no | no |
| 2 | 500 | 244.867 | 244.867 | 245.867 | 14,531.425 | 0.00000 | no / no | no |
| 3 | 700 | 406.407 | 406.407 | 407.407 | 24,078.838 | 0.18212 | no / no | no |
| 4 | 900 | 593.082 | 499.000 | 500.000 | 29,551.343 | 13.60609 | yes / no | **yes** |
| 5 | 1100 | 801.882 | 499.000 | 500.000 | 29,551.343 | 13.60609 | yes / no | yes (extrapolated) |
| 6 | 1300 | 1030.680 | 499.000 | 500.000 | 29,551.343 | 13.60609 | yes / no | yes (extrapolated) |
| 7 | 1500 | 1277.865 | 499.000 | 500.000 | 29,551.343 | 13.60609 | yes / no | yes (extrapolated) |

- **First binding limit:** server admission (`max_connections`).
- **First tested-ladder conditional error breach:** **900 RPS, rung 4.**
- **Interpolated 5% TMC crossing:** 771.780 RPS (equality is not a breach). **Interpolated server saturation:** 802.335 RPS; first tested saturated rung 900. These are separate model estimates, not measured transitions, and are not scored.
- **Prepared-statement cap:** never reached (peak 29,551 ≪ 65,528).
- Attempted app demand, leave-rep sensitivity range (not scored): 300: 95.466–134.230; 500: 236.564–253.461; 700: 384.890–429.124; 900: 525.667–669.126. Even the low fit exceeds the 499 app ceiling at 900, and even the high fit stays below it at 700.
- 700-rung TMC share at the rep maximum (0.728%) is still below 5%, so the 700 no-breach prediction does not depend on the leave-rep choice. At 900 both rep shares (9.41%, 17.70%) exceed 5%. [DERIVED]

### 5.3 Sensitivity scenarios (recorded as output by the candidate; **not scored**)
"Ordinary" connections count against `max_connections`; "exempt" ones do not (for example a reserved administrative slot). These are explicit assumptions, not observed splits.

| Scenario (ordinary / exempt) | First binding limit | Conditional breach | 5% crossing | Saturation | At 900–1500: admitted app / total open / prepared |
|---|---|---|---:|---:|---|
| observer-ordinary 1 / 0 (**primary, §5.2**) | server `max_connections` | breach, 900 (rung 4) | 771.780 | 802.335 | 499 / 500 / 29,551.343 |
| observer-exempt 0 / 1 | app pool and server tie | **unknown** | unknown | 803.404 | 500 / 501 / 29,610.446 |
| three-ordinary 3 / 0 | server `max_connections` | breach, 900 (rung 4) | 771.780 | 802.335 | 497 / 500 / 29,551.343 |
| three-exempt 0 / 3 | app pool and server tie | **unknown** | unknown | 805.540 | 500 / 503 / 29,728.651 |

- At rungs 1–3 all scenarios have the same total open connections as §5.2 (114.215, 245.867, 407.407) and the same prepared values. In the three-observer cases the attempted app demand is 2 lower (111.215, 242.867, 404.407, then 591.082 … 1275.865).
- In the two exempt scenarios the pool and server limits tie, so the candidate makes **no** TMC or breach prediction ("unknown", not "no breach"). The three-exempt case matches a possible observed total of 503 but does not prove 500 app slots.
- None of these scenarios changes §5.4–§5.6. They are reported next to the results for interpretation only.

### 5.4 Hypotheses (per rep, then campaign)
Evaluated **per rep**, with each rep's own first breach rung B (B = "none" if all 7 rungs complete), using the §3.1 breach rule.

Definitions:
- **1461 total** is the sum of errno 1461 deltas over all rungs of that apply, warmup and the partial breach step included.
- **TMC share of failures** is computed over steady-phase k6 `request_outcomes` at the breach rung: the count with class `too_many_connections` (HTTP 503) divided by **all failure points** at that rung, as in conn-3x §5.3. **This is a different quantity from the candidate's TMC %** (TMC / all responses, §5.2). The candidate's share is reported next to the measured TMC / all-responses share descriptively; it is not scored.
- **Server-limit reached** means max `Threads_connected` ≥ 0.98 × the recorded `max_connections` (490 at 500), in any 15 s sample from the start of the first rung through the breach declaration.

- **H1, per rep (pass).** All of the following hold:
  1. B = 900 (rung 4) is the first breach, with no breach at 300, 500 or 700;
  2. the breach is on the **error criterion**: error rate > 5% in each of the 3 breach minutes;
  3. **TMC share of failures > 50%** at the breach rung;
  4. 1461 total = 0;
  5. server-limit reached (≥ 490) at or before the 900 rung;
  6. every `Prepared_stmt_count` sample in the apply is < 65,528.
- **H0, per rep (fail).** Any of the following:
  - (a) B ≤ 700: a breach at 300, 500 or 700, **by any mechanism** (error or P95);
  - (b) no breach at 900: B ∈ {1100, 1300, 1500, none};
  - (c) B = 900 but the mechanism is not server connections: TMC share of failures ≤ 50%, or the server limit was not reached at or before 900;
  - (d) any 1461 delta > 0 in the apply;
  - (e) any `Prepared_stmt_count` sample ≥ 65,528. This is contrary to the locked "never reached" prediction.
- **Interpretation of H0(a) fixed in advance.** If H0(a) occurs **with TMC share of failures ≤ 50% at the breach rung** (for example an app-tier latency/CPU breach), the full first-breach prediction **fails**, and the DB server-limit component is reported as **untested at 2×**, not refuted, because the run stopped before the predicted server-limit rung. If H0(a) occurs with TMC share > 50%, the server-limit component is refuted (the server limit bound earlier than predicted).
- **Per-rep mixed.** Any other combination counts as mixed. The one case named in advance: B = 900 on the P95 criterion only (error rate ≤ 5% in at least one breach minute), with TMC share > 50% and the server limit reached. All values are reported.
- **Campaign verdict:**
  - **H1** if both valid reps are H1.
  - **H0** if both valid reps are H0.
  - **Not decided** otherwise: a rep is invalid after the replacement rules (§7.2) are exhausted or not run, the reps disagree (for example H1 and H0), or either rep is mixed.
  - There is no third rep to "settle" a disagreement.

### 5.5 Rep validity (as conn-3x §5.4, with E5 written out)
**Verdict-bearing evidence (E).** These are the only inputs to §5.4:
- **E1** — wait-ready `SHOW GLOBAL VARIABLES`: `max_prepared_stmt_count` = 65528 and `max_connections` = 500.
- **E2** — the breach-monitor per-minute rows for every rung through the breach declaration, or through the last rung if there is no breach.
- **E3** — the raw k6 `k6.json.gz` for every rung through the breach rung, hash-verified against the generator transfer before destroy. The per-minute P95 and error values and the steady `request_outcomes` are recomputable from it.
- **E4** — the 15 s observer polls, with ≤ 2 consecutive missing samples from the breach-rung start through declaration + 60 s, and ≤ 10% missing from the first rung start through declaration + 60 s.
- **E5 — generator validity [DECISION, adopted prospectively].** On every rung through the breach rung (or the last rung if there is no breach):
  - **dropped iterations / (completed k6 iterations + dropped iterations) ≤ 0.005**, counted over the **whole rung including warmup, through the actual stop** (elapsed until the breach stop, never the full planned rung), from the raw k6 `iterations` and `dropped_iterations` counters;
  - a rung with no iterations is unknown and fails E5 (no division by zero);
  - generator CPU steady mean ≤ 70% (dbsat-v1 §7.5).
  
  This is the stricter of the two readings disclosed in the conn-3x results. The dbsat-v1 §7.5 ratio, dropped / (RPS × 1,050), is reported **only as a sensitivity** and does not decide validity. The E5 denominator (iterations scheduled by the generator) is not the error-rate denominator of §3.1 (HTTP responses).

A rep is **invalid** (not a result; it follows the §7.2 replacement rules) if any of the following holds:
- any of E1–E5 is missing or fails;
- `max_prepared_stmt_count` ≠ 65528 at wait-ready;
- `max_connections` ≠ 500 at wait-ready. Another value changes the tested condition, and the rep is reported but not scored;
- a measurement, harness or infrastructure failure **starts before the breach declaration**, or before the last rung completes if there is no breach.

A failed validity check makes a rep invalid. It is not a pass or a fail of the candidate.

**Harness failure after the breach (pre-registered rule, unchanged from conn-3x §5.4).** A harness or infrastructure failure whose recorded start time is **after the breach declaration timestamp** does **not** invalidate the rep, provided E1–E5 are intact. This covers, for example, collect processing or boundary persistence failing after the stop. In that case:
- data that depends on the failed step (the live collect's CloudWatch/PI/pool aggregates, recovery) is reported as **unavailable**, never reconstructed;
- the breach rung's P95 and outcomes come from the preserved raw k6 using the pinned steady script, and are labelled as offline;
- the failure record (timestamp, stage, message) is kept unmodified in the evidence.

No rerun of that rep is made, and no owner exception is needed. Whether a failure is before or after the breach is decided only by comparing the controller's recorded failure timestamp with the breach-monitor declaration timestamp.

### 5.6 Mapping to the ladder [DERIVED, frozen]
- Predicted breach rung **B\* = 900**: the first tested rung where the candidate has the server ceiling binding and a TMC share above 5% (13.606%).
- The 5% crossing (771.78) and saturation (802.34) both fall between the 700 and 900 rungs, so the ladder resolves the prediction to "no breach at 700, breach at 900".
- The candidate's breach is conditional and ignores latency and non-TMC errors. A breach at or before 700 for those reasons is therefore possible without contradicting the candidate's connection model, which is why §5.4 fixes the H0(a) interpretation in advance.

## 6. Scoring
No new scorer. Per-rung records come from `score_dbsat_v1.record_from_collect` and `db_pressure`, and the §4.2 tables from the observer polls. H1/H0 is a lookup on those tables and the steady k6 outcomes using §3.1, §5.4 and §5.5, by an evaluation script committed with the results. It follows the conn-3x `evaluate_conn3x_v1.py` pattern, with the §3.1 eligible-minute rule recomputed from raw k6, the §5.5 E5 ratio, and the H0(a) interpretation. There are no transitions and no §7.4 confirmation in this campaign.

**Descriptive comparisons (not scored):** measured per-rung median-of-minute-max `Threads_connected`, `Prepared_stmt_count` and TMC / all-responses share against §5.2 and §5.3; app CPU per node against conn-3x and pscap-v1.

**Disclosed before freeze:** the `typical-dbsat-v1` 2× discovery runs (`typical/dbsat-v1/results/discovery-20261016/records.json`, 16,382 cap) breached at 500 (r1) and 700 (r2), on the error criterion, on `500/internal`. They ran under a different `max_prepared_stmt_count` and were not fit data. They are reported descriptively with the results and do not change any prediction above.

## 7. Operations
### 7.1 Runner autonomy (as conn-3x §7.1)
- **Proceed without asking:**
  - Pre-workload failures with 0 rungs started: workspace restart, readiness failure (including the app bootstrap seed race), AWS API timeout/throttle, capacity/launch errors, SSM/bootstrap transport failures. Destroy, verify cleanup, and retry the same apply **up to 2 times**. These retries are **not** replacements, and each is logged as a deviation with cause and UTC time.
  - Cleanup recovery (state reconciliation, import-to-destroy of verified orphans).
  - Valid data, meaning breaches, failed recoveries and partial steps: record them and continue in order.
  - **A harness failure after the breach declaration with E1–E5 intact (§5.5):** preserve the evidence, destroy, verify cleanup, record it, and continue to the next rep. No replacement is made.
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
- **Up to 3 replacements**, only for invalid reps (§5.5), as in dbsat-v1 §7.7. At the cap, pause and ask. Replacements use the next letter suffix (`r1a`, `r1b`, …).
- A workload breach or recovery failure is valid evidence and never authorizes a replacement. Neither does a post-breach harness failure with E1–E5 intact.
- [DERIVED] Spend estimate:
  - conn-3x spent **$3.92** for 2 reps on 3× (4 rungs each).
  - 2× has one fewer app node, and the predicted breach at 900 means about 4 rungs per rep, so the estimate is **≈ $3.5–4.5 for 2 reps**.
  - Replacements cost ≤ 3 × ~$2.5 ≈ $7.5.
  - Worst case ≈ $12, under $25.

### 7.3 Cleanup and redaction (as conn-3x §7.3)
- Destroy after each apply. Run immediate and ≥ 15-minute delayed cleanup checks in us-east-2 and us-west-2.
- Before publication, the evidence archive is redacted as in `typical/dbsat-conn-3x-v1/results/holdout-20261018/REDACTION.md`:
  - account ID and ARNs;
  - public IPs;
  - RDS endpoint hash and resource IDs;
  - ALB DNS numbers;
  - EC2 instance and volume IDs, including in file and directory names;
  - SSM command IDs;
  - runner paths.
- The redacted derivative gets new hashes, and the private original's SHA256 is recorded. Raw k6 gzips stay off-repo.

## 8. Required changes before the first apply (no app/load change)
1. **Repo wiring: none required [FACT, checked against `main` @ 057bb31d].**
   - Apply IDs reuse the pscap ID family (§9). `DBSAT_PSCAP_TEST_ID_RE` / `DBSAT_TEST_ID_RE` in `scripts/lib/adapter/ladder.mjs` already accept scale `2x` (checked: `typical-dbsat-pscap-2x-r1-20261020` and `typical-dbsat-pscap-2x-r2b-20261020` match).
   - The 2× scenario keys `typical-dbsat-2x-{300,500,700,900,1100,1300,1500}` exist in `scripts/lib/adapter/scenarios.mjs` with `expectedAppCount` 2, matching the ID scale.
   - The wait-ready gate already enforces `max_prepared_stmt_count = 65528` for that family (`scripts/lib/adapter/ready.mjs`).
   - Terraform `app_count` defaults to 2; `mysql_max_prepared_stmt_count` exists, and `mysql_max_connections` (default 500) sets `max_connections` in the DB parameter group.
2. **Runner-side controller (not in this repo).** Start from the conn-3x controller **conn3-1.0.0** (controller SHA256 `b75972e03de0d5558a35524332f3e68fe7b7139b07e7317b64e9437558320414`, manifest SHA256 `c6ade740bc1dabc418382e7a898bc1398e6761f676d529b8698cac0298717465`). Changes before any paid apply:
   - (a) accept the 2× app count and the §9 IDs;
   - (b) apply the §3.1 breach rule with explicit complete-steady-minute eligibility (a missing or incomplete minute breaks the streak);
   - (c) record per rung the raw k6 completed and dropped iterations through the actual stop, warmup included, and report the §5.5 E5 ratio, with the dbsat-v1 RPS × 1,050 ratio alongside as a sensitivity;
   - (d) keep conn3-1.0.0's wait-ready `max_connections` recording and timestamped problem records (stage + failure time) for §5.5;
   - (e) compute TMC share of failures and TMC / all-responses at the breach rung in the run summary (descriptive; scoring recomputes both).

   Required offline tests: a simulated 2× breach captures the InnoDB/error snapshot; a gap in steady minutes resets the breach streak; an early-stopped rung's E5 ratio uses elapsed-until-stop counts; an aborted rung keeps its original raw gzip; a simulated post-breach processing failure produces a timestamped problem record with E1–E5 intact. Record the new controller manifest SHA256, the diff and the test logs with the evidence.
3. The wiring commit is `main` at freeze, with `git diff 881e0cf -- app-typical/ load/` empty. The evidence records both that commit and 881e0cf.

## 9. Names and paths
- `typical/dbsat-conn-2x-v1/PREREGISTRATION.md`
- Applies: `typical-dbsat-pscap-2x-r{1,2}[letter]-YYYYMMDD`. This reuses the pscap ID family because it carries the 65,528 parameter gate. pscap-v1 used only 4× and conn-3x only 3×, so the 2× IDs cannot collide with either.
- Parent ID: `typical-dbsat-conn-2x-v1-YYYYMMDD`
- Evidence: `typical/campaign/typical-dbsat-conn-2x-v1-<date>/`
- Results: `typical/dbsat-conn-2x-v1/results/`

## 10. Risks
- **App tier first.** On 2×, 700 RPS is 350 RPS per server and 900 is 450, well above any per-server load measured in pscap-v1 or conn-3x. App CPU, the event loop or `queueLimit` could breach first at or below 700. That is H0(a) and, with TMC share ≤ 50%, leaves the server-limit component untested (§5.4).
- **Pool and server tie.** With a 500 pool fleet against `max_connections` 500, a small change in observer/system occupancy moves the binding limit between the pool and the server (§5.3). Pool waits instead of `too_many_connections` rejections would show as H0(c) or a P95-only breach (mixed).
- **Stricter E5 at the breach rung.** Under the §5.5 ratio, the conn-3x breach rungs measured 0.54% and 0.74%, above 0.5%. If 2× overload behaves the same, reps can be invalid, replacements may not fix it, and the campaign can end **not decided**. This is accepted in advance; the rule is not relaxed after the fact.
- **Extrapolation.** The demand curve is applied to a topology it was not fitted on, and its leave-rep fits disagree on the exponent (1.24–1.76).
- Reps may disagree. The result is then "not decided", with no third rep.
- The recovery-rule artifact and the AAS window-end null bug may recur. They are disclosed and not scored.

## 11. Changelog
- r1 (2026-10-18): initial draft.
