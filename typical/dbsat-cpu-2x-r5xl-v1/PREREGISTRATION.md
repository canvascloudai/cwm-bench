# cwm-bench `typical-dbsat-cpu-2x-r5xl-v1`: DB-CPU holdout for the CPU/service/pool candidate (2× m5.large, db.r5.xlarge, max_connections = 500), pre-registration

Status: **r1 draft, frozen on merge of this PR plus Kevin Brown's written approval of the harness manifest in §8.3**. Nothing has been applied on AWS for this campaign. Written 2026-10-22. Owner: Kevin Brown. Structure, workload, generator, breach rule, validity rules and operations follow `typical/dbsat-conn-2x-v1.1/PREREGISTRATION.md` (v1.1 r2, merged at `ec3bb059`) unless stated here.

This campaign is a **holdout** for the internal CWM candidate `mysql-cpu-service-pool-v3` (unpublished, disabled by default, not in production execution). It is a separate campaign and is **never pooled** with `typical-dbsat-v1`, `typical-dbsat-pscap-v1`, `typical-dbsat-conn-3x-v1`, `typical-dbsat-conn-2x-v1` or `typical-dbsat-conn-2x-v1.1`. Any change to §2–§7 after freeze means `typical-dbsat-cpu-2x-r5xl-v2`.

Labels: **[FACT]** · **[DECISION]** · **[ASSUMPTION]** · **[DERIVED]** · **[OPEN]**.

---

## 0. Summary
- `typical-dbsat-conn-2x-v1.1` (2× m5.large, db.r5.large) closed **H0**: both reps breached at the predicted 900 rung, but `too_many_connections` was only 14.6% / 22.1% of failures. `503/queue_full` dominated and DB CPU was about 99.5%. [FACT; `typical/dbsat-conn-2x-v1.1/RESULTS.md`]
- The candidate under test adds a DB-CPU → service time → pool wait → `queue_full` path to the connection limit and the prepared-statement cap, and was fitted on all six valid reps of pscap-v1 (4×), conn-3x-v1 (3×) and conn-2x-v1.1 (2×), all on db.r5.large (§5.1).
- This holdout changes **one thing** relative to conn-2x-v1.1: **db.r5.large → db.r5.xlarge** (twice the vCPUs). If DB CPU is what drove `queue_full` at 2×, doubling DB CPU should remove it.
- Frozen nominal prediction: **no qualifying breach on the tested ladder through 1500 RPS**, `queue_full` and pool wait zero at every rung, DB CPU 75.9% at 1500 (§5.2).

## 1. Questions
- **Q1 (scored, §5.4).** On 2× m5.large with db.r5.xlarge and `max_connections` 500, does each rep complete the 300 → 1500 ladder with **no qualifying breach** (§3.1)?
- **Q2 (descriptive, not scored).** Peak DB CPU per rung against the frozen values (75.9% at 1500), `queue_full` and `too_many_connections` shares per rung, pool wait, `Threads_connected`, app CPU, compared descriptively with conn-2x-v1.1 (never pooled).

## 2. Fixed topology [FACT unless marked]
- us-east-2. Internal ALB. **2× m5.large** app servers on the pinned AMI `ami-0d3d85815a9746bc5`. Node typical CRUD service, `app_workers=2`, per-node mysql2 pool 250 (fleet 500), `queueLimit` 50 per worker.
- **db.r5.xlarge** MySQL 8.0, single-AZ, gp2 100 GiB, Performance Insights on, via `-var db_instance_class=db.r5.xlarge`. RDS engine version recorded per apply; the target is `8.0.46-rds.20260908` as in v1.1, and a different version is a disclosed confound.
- c6i.xlarge k6 generator, 1 generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5` (preAllocatedVUs = max(20, ceil(RPS × 0.5)), maxVUs = max(preAllocatedVUs, ceil(RPS × 2.5))).
- **App and load code byte-identical to measurement SHA `881e0cf`** (`app-typical/`, `load/typical.js`, `load/lib/`). Typical mix unchanged (article list/detail/profile/comment/login 59/20/10/10/1%). Fresh seed per apply.
- **DB parameters [DECISION]:** `max_connections = 500` (parameter-group override via `mysql_max_connections`, not the RDS formula default, which is higher on db.r5.xlarge) and `max_prepared_stmt_count = 65528` (`-var mysql_max_prepared_stmt_count=65528`), both unchanged from v1.1 and recorded at wait-ready.
- **The only intervention vs conn-2x-v1.1 [DECISION]:** DB instance class db.r5.large → db.r5.xlarge.

## 3. Configuration, ladder and schedule
| Item | Value |
|---|---|
| Server count | 2× m5.large only |
| DB | db.r5.xlarge only |
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, ascending, no retries within an apply. Rung index 300 = 1 … 1500 = 7 |
| Step | 300 s linear warmup + 900 s steady; 1,200 s planned elapsed |
| Reps | **2 applies** (`r1`, `r2`), each fresh with no stack reuse. Same UTC day allowed and disclosed |
| Breach (§3.1) | 3 consecutive complete steady minutes, each with error rate > 5% or P95 > 2,000 ms |
| Recovery | Run and recorded for evidence only (known idle-connection artifact, no weight) |

### 3.1 Breach rule (identical to v1.1 §3.1) [DECISION]
- **Eligible minute:** a full UTC minute `[start, end)` entirely inside `phase=steady`. A missing or incomplete minute is not eligible and **breaks the streak**.
- **Minute condition:** error rate > 0.05 **or** nearest-rank HTTP P95 > 2,000 ms; error rate = all HTTP failure responses / all HTTP responses in that minute (status ≥ 400 or 0, classed by `request_outcomes_from_k6`). Equality is not a breach.
- **Breach:** 3 consecutive eligible minutes each meeting the condition. Stop the rung and the sweep at the end of the third qualifying minute. Warmup breaches do not count.
- **No breach** means no qualifying rung on the tested ladder. It never means unlimited capacity.

## 4. Measurements
- As v1.1 §4.1 (unchanged scorer `typical/dbsat-v1/score_dbsat_v1.py`) and v1.1 §4.2–§4.3 (15 s observer polls, wait-ready variables, occupancy/privilege records, breach-time snapshots if a breach occurs, continuous app logs).
- **Added at wait-ready [DECISION]:** record the RDS instance class as reported by AWS (`DBInstanceClass`) and the instance vCPU count. Both must equal db.r5.xlarge / 4 vCPU (E1, §5.5).
- **DB CPU for Q2:** CloudWatch RDS `CPUUtilization`, 1-minute, per rung: steady mean and peak 1-minute value. PI AAS and CPU-wait share descriptive.
- **Failure classes:** steady-phase k6 `request_outcomes` per rung, as `queue_full`, `too_many_connections`, `internal`, other; shares of all responses and of failures.

## 5. Frozen predictions (written 2026-10-22, before any apply)

### 5.1 Locked candidate: `mysql-cpu-service-pool-v3` (internal, unpublished, disabled by default)
- **Status.** Not enabled in normal CWM runs, not published, absent from production execution. The published engine is unchanged. **No accuracy claim is made for it in this prereg or before this holdout is scored.**
- **Provenance [FACT].**
  - Implementation commit: `7353980004ea8a79cca614a77bbcd61b0898ca77` (fitted parameters, sources and the 3× xlarge freeze).
  - 2× xlarge freeze commit: `d378a2dc4eaa741fb0adea51f10233dc9fb727f1` (prediction-only, no refit).
  - **Frozen artifact scored here:** `reports/mysql-cpu-v3/freeze-2x-r5xl-v1.json`, SHA256 `d7c2fca052a88a8ee17a46fa55128f57ab63e096fac2c72fb105919e1b718f76` (report `.md` `68834a954ddffe6fa1770f75bf3c0098fcf2375a5e02507e18213e12d44a3050`). Its `--check` regeneration passed and 13 historical files hash-matched, including the original 3× xlarge freeze `freeze.json` SHA256 `ebffeecccc9d48bd28a34cfa28c4c06aac394c16e67df5490d413e8ad2d7691e`, which is unchanged.
- **Fit data [FACT].** All six reps of pscap-v1 r1/r2 (4×), conn-3x-v1 r1/r2 (3×) and conn-2x-v1.1 r1/r2 (2×), rungs 300–900, all on db.r5.large. **All six are fit data and cannot count as evidence for the candidate.** No xlarge run and no data from this campaign is a fit input. conn-2x-v1 rep 1 and optional discovery runs were not used.
- **Fit quality [FACT, disclosed].** The full fit reproduces the 900 first breach and dominant class in all six reps. Numerical residuals are poor: largest training residuals DB CPU 22.1 pp, max `Threads_connected` 106, total error 7.0 pp, HTTP P95 849 ms. For conn-2x-v1.1 at 900 it predicts `too_many_connections` at 0.43% of failures against 15.3% / 21.3% observed.
- **Leave-one-campaign-out [FACT, disclosed].** The folds leaving out pscap-v1 and conn-3x-v1 reproduce their held-out campaign's 900 / `too_many_connections` breach. **The fold leaving out conn-2x-v1.1 fails:** it predicts no breach through 900 (dominant `internal`, 1.76% error) against an observed 22.4% / 24.3% `queue_full` breach. The `queue_full` mechanism is therefore only supported by the data it was fitted to.
- **Assumptions [ASSUMPTION].**
  - **CPU transfer is unvalidated.** db.r5.xlarge is modelled as CPU capacity multiplier 2 only, with no service-time or memory benefit. This is what the holdout tests.
  - Query service time, busy/retained connection occupancy and tail parameters are nonidentifiable phenomenological parameters, not measurements.
  - Prepared coefficient 59.10268577018286 unchanged; failure-class attribution order is fixed by assumption.
  - All rungs transfer to unseen hardware; 1100–1500 also extrapolate beyond observed load.

### 5.2 Frozen nominal prediction (CPU multiplier 2; **scored**)
| RPS | DB CPU % | Error % | HTTP P95 ms | Open conns | Max threads proxy | Binding CPU / server / pool / queue |
|---:|---:|---:|---:|---:|---:|---|
| 300 | 15.174 | 0.107 | 29.77 | 122.98 | 125.98 | no / no / no / no |
| 500 | 25.290 | 0.107 | 37.65 | 277.32 | 280.32 | no / no / no / no |
| 700 | 35.406 | 0.107 | 49.36 | 474.51 | 477.51 | no / no / no / no |
| 900 | 45.521 | 0.181 | 67.92 | 500 | 503 | no / yes / no / no |
| 1100 | 55.637 | 0.181 | 100.00 | 500 | 503 | no / yes / no / no |
| 1300 | 65.753 | 0.181 | 163.15 | 500 | 503 | no / yes / no / no |
| 1500 | 75.869 | 0.181 | 317.09 | 500 | 503 | no / yes / no / no |

- Failure shares of failures: 300–700 100% other; 900–1500 41.1% `too_many_connections`, 58.9% other. **`queue_full` 0% and pool wait zero at every rung.**
- **First breach: none on the tested ladder.** Headroom at 1500 [DERIVED]: error 0.18% vs 5% (≈ 27×), P95 317 ms vs 2,000 ms (≈ 6×). The model has the server connection ceiling binding from 900 but producing only ≈ 0.07% `too_many_connections` errors.

### 5.3 Sensitivity scenarios (recorded by the candidate; **not scored**)
| Variant | First breach | Criterion / dominant class | Error % / P95 ms at 1300 | Error % / P95 ms at 1500 |
|---|---|---|---|---|
| Capacity multiplier 1.5 | **1500** | error and P95 / **`queue_full`** | 1.72 / 1,158 | 99.9 / 1,388,871 |
| Capacity multiplier 2.5 | none | — | 0.18 / 88 | 0.18 / 126 |
| LOCO without pscap-v1 | none | — | 0.42 / 161 | 0.42 / 332 |
| LOCO without conn-3x-v1 | none | — | 0.08 / 235 | 0.08 / 432 |
| LOCO without conn-2x-v1.1 | none | — | 0.07 / 141 | 0.07 / 275 |

- These are model envelopes, not confidence intervals. LOCO rows apply saved fold parameters to this scenario; they are not new held-out measurements.
- **Scoring is always against the nominal §5.2 prediction [DECISION].** No sensitivity variant may be selected after results. The capacity-1.5 breach is disclosed before any apply and does not change H1/H0.

### 5.4 Hypotheses (per rep, then campaign)
Evaluated per rep with that rep's first breach rung B (B = "none" if all 7 rungs complete), using §3.1.
- **H1, per rep (pass):** B = none — no qualifying breach at any rung 300 through 1500.
- **H0, per rep (fail):** a qualifying breach at any rung ≤ 1500, by any criterion or mechanism.
- **Campaign verdict:**
  - **H1** if both valid reps are H1.
  - **H0** if both valid reps are H0.
  - **Not decided** if the reps disagree, or fewer than 2 valid reps remain after the §7.2 replacement rules. No third rep.
- **Mechanism interpretation, fixed in advance (reported, never scored):**
  - H0 with **`queue_full`** dominant at the breach rung (> 50% of failures): DB CPU / service capacity did not scale as assumed; consistent with the capacity-1.5 sensitivity if at 1500, and below it if earlier.
  - H0 with **`too_many_connections`** dominant: the connection side of the model is wrong (it predicts only ≈ 0.07% TMC errors with the ceiling binding), independent of CPU.
  - H0 with **`internal`** or other dominant, or on P95 only: a mechanism the candidate does not model.
  - H0 at a rung **below 1500**: outside every recorded variant, including capacity 1.5.
  - H1: supports the no-breach prediction only. The CPU-transfer value, residual sizes and the connection curve are reported, not validated.
- **Always reported (descriptive):** per-rung peak and steady-mean DB CPU against §5.2 (75.9% at 1500); `queue_full` and `too_many_connections` shares (of all responses and of failures) per rung against 0% / §5.2; per-rung pool-wait P95; max `Threads_connected`; prepared-statement peak.

### 5.5 Rep validity (as v1.1 §5.5, with E1 extended)
- **E1:** wait-ready `SHOW GLOBAL VARIABLES` `max_prepared_stmt_count` = 65528 and `max_connections` = 500, **and** recorded RDS instance class = db.r5.xlarge (§4).
- **E2–E4:** as v1.1 §5.5, including the no-breach coverage definitions (all seven rung gzips; observer-poll gaps within every steady phase).
- **E5:** as v1.1 §5.5: **E5-pre** (strict dropped / (completed + dropped) ≤ 0.005 over the whole rung and generator CPU steady mean ≤ 70%) for rungs below the breach rung and **every rung if there is no breach**; **E5-breach** (generator health: CPU minutes ≤ 70% with none missing, breach stop marker, k6 exit 105 or 0, only the interrupt `level=error` line, no pre-breach harness error) at the breach rung. Both dropped ratios reported descriptively.
- Invalidity, post-breach harness-failure rule and "invalid is not a pass or fail" as v1.1 §5.5. A wrong DB instance class makes the rep invalid (reported, not scored).

## 6. Scoring
No new scorer. Per-rung records from `score_dbsat_v1.record_from_collect` and `db_pressure`; H1/H0 is a lookup using §3.1, §5.4 and §5.5 by an evaluation script committed with the results, following `typical/dbsat-conn-2x-v1.1/results/holdout-20261022/evaluate_conn2x_v11.py` with the hypotheses replaced by §5.4 and the no-breach path exercised. conn-2x-v1.1 data appear only as a separate descriptive comparison.

## 7. Operations
### 7.1 Runner autonomy
As v1.1 §7.1 (proceed / proceed-then-report / stop-and-ask lists unchanged). The runner is the existing **stopped** independent AWS runner from v1.1; it is started for this campaign and stopped (not terminated) afterwards.

### 7.2 Budget and replacements
- **Soft cap $25.** At the cap, **pause and ask Kevin**; never auto-stop.
- Up to 3 replacements, only for invalid reps, next-letter suffix. A workload breach is valid evidence and never authorizes a replacement.
- [DERIVED] Spend estimate: a no-breach rep runs all 7 rungs (≈ 2.3 h of load plus apply/destroy). db.r5.xlarge is about twice the db.r5.large hourly rate. Estimate **≈ $2.5–3.5 per rep, ≈ $5–7 for 2 reps**; replacements ≤ 3 × ~$3.5; worst case ≈ $17, under $25.

### 7.2a After load, recovery is cleanup only
As v1.1 §7.2a.

### 7.3 Cleanup and redaction
As v1.1 §7.3: destroy after each apply; immediate and ≥ 15-minute delayed cleanup checks in us-east-2 and us-west-2; redact account ID and ARNs, public IPs, RDS endpoint hash and resource IDs, ALB DNS numbers, EC2 instance and volume IDs (including file/directory names), SSM command IDs and runner paths before publication; raw k6 gzips stay off-repo.

## 8. Required changes before the first apply (no app/load change)
1. **Repo (this PR) [FACT, checked against `main` @ c6bd50e].**
   - `terraform/locals.tf`: the `Topology` tag was hard-coded `…-m5.large-db.r5.large-…`. It now uses `${var.app_instance_type}` and `${var.db_instance_class}`; at the defaults it renders identically. Tag-only.
   - `db_instance_class` already exists (`terraform/variables.tf`, used in `terraform/rds.tf`); no other Terraform change. Other `db.r5.large` strings are defaults, docs, historical payloads/logs or test fixtures and are unchanged.
   - Scenario keys `typical-dbsat-2x-{300…1500}` (`expectedAppCount` 2) and the pscap 2× ID family with its 65,528 wait-ready gate already exist. The adapter does not check DB instance class, so that check is runner-side (§8.2).
2. **Runner-side controller (not in this repo).** Start from the v1.1 controller (SHA256 `52d8bc74c4cd0adfb55b24b082f8a230ea73a1a40177eb426a9e5a4c5e184434`, executed manifest `a115312f…392a`). Changes before any paid apply:
   - (a) pass `-var db_instance_class=db.r5.xlarge` and record and gate the AWS-reported instance class and vCPU count at wait-ready (E1);
   - (b) accept this campaign's IDs and refuse any ID already in a prior journal (§9);
   - (c) record per-rung RDS `CPUUtilization` steady mean and peak 1-minute value, and per-rung failure-class shares, in the run summary (descriptive; scoring recomputes);
   - (d) the evaluation path handles a **full no-breach ladder**: E3/E4/E5-pre over all seven rungs.
   Required offline tests: a wrong instance class fails E1; a 7-rung no-breach fixture scores H1 with complete E2–E5; a breach fixture at 1500 with `queue_full` dominant scores H0 with the correct mechanism label. Full offline suites plus an EC2 no-load rehearsal on the exact final manifest, with cleanup passing in both regions.
3. **Frozen harness/runner manifest [OPEN; filled in by the runner before freeze, approved by Kevin].**
   - Manifest SHA256: `<TBD by runner>`
   - Controller SHA256: `<TBD by runner>` (predecessor `52d8bc74c4cd0adfb55b24b082f8a230ea73a1a40177eb426a9e5a4c5e184434`)
   - Offline suite counts, rehearsal and cleanup times: `<TBD by runner>`
   - Any later harness-only change means a new manifest SHA, recorded as a deviation under §7.1.
4. The wiring commit is `main` at freeze, with `git diff 881e0cf -- app-typical/ load/` empty.

## 9. Names and paths
- `typical/dbsat-cpu-2x-r5xl-v1/PREREGISTRATION.md`
- Applies: `typical-dbsat-pscap-2x-r{1,2}[letter]-YYYYMMDD` (pscap 2× family, carries the 65,528 gate). **No apply ID may reuse any ID from v1 or v1.1**; the controller refuses journaled IDs.
- Parent ID: `typical-dbsat-cpu-2x-r5xl-v1-YYYYMMDD`
- Evidence: `typical/campaign/typical-dbsat-cpu-2x-r5xl-v1-<date>/`
- Results: `typical/dbsat-cpu-2x-r5xl-v1/results/`

## 10. Risks
- **App tier or generator at high rungs.** At 1500 RPS each app server takes 750 RPS, far above any completed rung so far. An app-side breach is H0 with a non-modelled mechanism (§5.4). If the generator falls behind before any breach, E5-pre fails and the rep is invalid, not H0.
- **Connection ceiling binding with no errors.** The model has the 500 ceiling binding from 900 with almost no rejections; v1.1 measured 15–21% TMC of failures at 900 on db.r5.large. A TMC-dominated breach is a live possibility.
- **CPU transfer.** If xlarge gives less than about 1.5× effective DB capacity, a `queue_full` breach near 1500 is expected (§5.3).
- **Instance availability.** db.r5.xlarge capacity in us-east-2 is not checked; a launch failure is a pre-workload retry under §7.1.
- Reps may disagree; the result is then not decided.

## 11. Excluded: 3× m5.large + db.r5.xlarge [DECISION]
A 3× xlarge freeze exists (`freeze.json`, SHA256 `ebffeecc…7691e`: first breach 900, `too_many_connections` dominant, DB CPU 45.5% at 900). It is **not run** here. 3× on db.r5.large already breached at 900 with `too_many_connections` dominant (fit data), and the xlarge prediction is the same outcome driven by the connection ceiling, with the CPU term never binding. It would cost a second campaign while barely testing the new mechanism. It may be run later as a separate, descriptively labelled campaign.

## 12. Changelog
- r1 (2026-10-22): initial draft. Topology tag fix in `terraform/locals.tf` (tag-only).
