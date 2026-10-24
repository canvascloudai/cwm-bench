# cwm-bench `typical-dbsat-cpu-2x-m5xl-v1`: DB-family transfer holdout for the CPU/service/pool candidate v4 (2× m5.large, db.m5.xlarge, max_connections = 500), pre-registration

Status: **r1 draft. It freezes on merge of this PR plus Kevin Brown's written approval of the harness manifest in §8.3.** Nothing has been applied on AWS for this campaign. Written 2026-10-24. Owner: Kevin Brown.

The harness, workload, generator, breach rule, validity rules and operations are **identical to `typical/dbsat-cpu-2x-r5xl-v1/PREREGISTRATION.md`** (merged at `9a8d720c`; results H0, merged at `8dae96a0`) unless stated here. That prereg in turn follows `typical/dbsat-conn-2x-v1.1/PREREGISTRATION.md`.

This campaign is a **holdout** for the internal CWM candidate `mysql-cpu-service-pool-v4` (unpublished, disabled by default, not in production execution). It is a separate campaign and is **never pooled** with any earlier dbsat campaign, including `typical-dbsat-cpu-2x-r5xl-v1`. Any change to §2–§7 after freeze means `typical-dbsat-cpu-2x-m5xl-v2`.

Labels: **[FACT]** · **[DECISION]** · **[ASSUMPTION]** · **[DERIVED]** · **[OPEN]**.

---

## 0. Summary
- **Prior result.** `typical-dbsat-cpu-2x-r5xl-v1` (2× m5.large, db.r5.xlarge) closed **H0** against v3. v3 predicted no breach through 1500, but both reps breached at 1500 on error (10.1% / 17.1% steady error), with `queue_full` dominant (81.6% / 79.9% of failures) and DB CPU ≈ 94–96%. [FACT; `typical/dbsat-cpu-2x-r5xl-v1/RESULTS.md`]
- **Candidate.** v4 is the candidate after v3. It refits DB CPU capacity and tail latency, and its fit data include r5xl-v1 (§5.1).
- **What changes.** This holdout changes **one thing** relative to r5xl-v1: **db.r5.xlarge → db.m5.xlarge**. Both have 4 vCPU; m5 has 16 GiB of memory against r5's 32 GiB.
- **DB-family transfer test [DECISION, label].** v4 has **no DB-family term**: db.m5.xlarge receives exactly the saved 4-vCPU r5 prediction. This campaign therefore tests whether the r5-calibrated prediction transfers across instance families. It does not test an independently calibrated m5 model.
- **Frozen nominal prediction:**
  - First qualifying breach at **1500 RPS** on the error criterion: 12.2266% error, P95 1,282.84 ms, DB CPU 99.7%, `queue_full` dominant.
  - No breach at 300–1300 (§5.2).

## 1. Questions
- **Q1 (scored, §5.4).** On 2× m5.large with db.m5.xlarge and `max_connections` 500, is each rep's **first qualifying breach at exactly 1500 RPS** (§3.1)?
- **Q2 (mechanism check, preregistered label; not part of H1/H0, §5.5a).** At an observed breach, is it DB-limited or app-limited (mechanism not decided)?
- **Q3 (descriptive, not scored).** Report per rung, against §5.2:
  - steady-mean and peak DB CPU;
  - error % and P95;
  - `queue_full` and `too_many_connections` shares;
  - pool wait, `Threads_connected` and app CPU.
  
  These are compared descriptively with r5xl-v1, never pooled.

## 2. Fixed topology [FACT unless marked]
- **Unchanged from r5xl-v1 §2.**
  - us-east-2, internal ALB.
  - **2× m5.large** app servers on the same pinned AMI as r5xl-v1.
  - Node typical CRUD service with `app_workers=2`: per worker, mysql2 pool 125 and `queueLimit` 50 (per node 250; fleet 500).
- **db.m5.xlarge** MySQL 8.0, single-AZ, gp2 100 GiB, Performance Insights on, set via `-var db_instance_class=db.m5.xlarge`.
  - The RDS engine version is recorded per apply. The target is the same as r5xl-v1 (`8.0.46-rds.20260908`); a different version is a disclosed confound.
  - Performance Insights support on db.m5.xlarge is expected [ASSUMPTION]. If PI is unavailable, PI metrics are reported missing; they are descriptive only and do not affect validity.
- **Generator.** One c6i.xlarge k6 generator with `CWM_VU_PRE_S=0.5` and `CWM_VU_MAX_S=2.5`:
  - preAllocatedVUs = max(20, ceil(RPS × 0.5));
  - maxVUs = max(preAllocatedVUs, ceil(RPS × 2.5)).
- **App and load code are byte-identical to measurement SHA `881e0cf`** (`app-typical/`, `load/typical.js`, `load/lib/`).
  - The typical mix is unchanged: article list / detail / profile / comment / login at 59 / 20 / 10 / 10 / 1%.
  - Fresh seed per apply.
- **DB parameters [DECISION].** Both are unchanged and recorded at wait-ready:
  - `max_connections = 500`, as a parameter-group override, not the RDS formula default;
  - `max_prepared_stmt_count = 65528`.
- **The only intervention vs r5xl-v1 [DECISION]:** DB instance class db.r5.xlarge → db.m5.xlarge.

## 3. Configuration, ladder and schedule
As r5xl-v1 §3, with DB = **db.m5.xlarge only**.

| Item | Value |
|---|---|
| Ladder (total RPS) | 300, 500, 700, 900, 1100, 1300, 1500, ascending, no retries within an apply |
| Step | 300 s linear warmup + 900 s steady |
| Reps | **2 applies**, each fresh, no stack reuse |
| Breach (§3.1) | 3 consecutive complete steady minutes, each with error rate > 5% or P95 > 2,000 ms |

### 3.1 Breach rule (identical to r5xl-v1 §3.1 / v1.1 §3.1) [DECISION]
- **Eligible minute:** a full UTC minute `[start, end)` entirely inside `phase=steady`. A missing or incomplete minute is not eligible and **breaks the streak**.
- **Minute condition:** error rate > 0.05 **or** nearest-rank HTTP P95 > 2,000 ms. Equality is not a breach.
  - Error rate = HTTP failure responses / all HTTP responses in the minute.
  - A failure is status ≥ 400 or 0, classed by `request_outcomes_from_k6`.
- **Breach:** 3 consecutive eligible minutes each meeting the condition. Stop the rung and the sweep at the end of the third qualifying minute. Warmup breaches do not count.
- **No breach** means no qualifying rung on the tested ladder. It never means unlimited capacity.

## 4. Measurements
- As r5xl-v1 §4: unchanged scorer `typical/dbsat-v1/score_dbsat_v1.py`, 15 s observer polls, wait-ready variables, breach-time snapshots, per-rung RDS `CPUUtilization` steady mean and peak, and per-rung failure classes.
- **At wait-ready [DECISION]:** record the AWS-reported `DBInstanceClass` and the instance vCPU count. They must equal **db.m5.xlarge / 4 vCPU** (E1, §5.5).
- **Mechanism inputs (§5.5a):** the DB CPU steady-window mean through the actual stop, and steady failure counts in four exhaustive classes (`queue_full`, `too_many_connections`, `internal`, other), pooled over the same whole steady window including partial boundary minutes.

## 5. Frozen predictions (frozen 2026-10-24, before any apply)

### 5.1 Locked candidate: `mysql-cpu-service-pool-v4` (internal, unpublished, disabled by default)
- **Status.** Not enabled in normal CWM runs, not published, absent from production execution. **No accuracy claim is made for it before this holdout is scored.**
- **Provenance [FACT].**
  - Freeze merged in the internal CWM app at commit `787b301c1a326a90f0defad39908b0631a16aca1`.
  - Implementation revision `47b5567b05f5e6c129d1add1e24ad4638fd55b47`.
  - Input lock `freeze-2x-m5xl-v1-inputs.json`, SHA256 `ddc01332ee0ed802472e7c44c16404124192f8fafb993364eb0b3dfcc3157e7c`.
  - Parameter SHA256 `ad3d8f5b4aa9c9398d57e432ea1a0c166a4878beefd8f42824a8f5fdce57f740`.
  - Fold SHA256 `d49284bd963f8dc712f953418d9b0ad2ff72e81f1ed05cec91c5830c240f18bb`.
  - Source lock SHA256 `3b92dbdfca5a0f091608c6449e3ecb02dd44cbf2408e09ac5134a90f64202af6`.
- **Frozen artifact scored here:** `reports/mysql-cpu-v4/freeze-2x-m5xl-v1.json`, SHA256 **`083bb0c6f8ab171ed749ec85950a579763c2ec3380284de96ce07366939bd598`**.
  - Readable report `freeze-2x-m5xl-v1.md`: SHA256 `ad3c41391aac5c7ca1adf71b61eaf3532df22639ce94422ef15c16427d7c844c`.
  - Both hashes are from the output receipt `freeze-2x-m5xl-v1-sha256.json`.
  - The freeze script is read-only by default, reproduces the output bytes and the receipt, and refuses to overwrite differing artifacts.
- **No family term [FACT, disclosed].** Family transfer is assumed at 4 vCPU with no family-specific adjustment. The CPU/service and HTTP/pool tails are phenomenological. The holdout outcomes were not accessed when the freeze was made.
- **Fit data.** v4's fit includes `typical-dbsat-cpu-2x-r5xl-v1`. **No db.m5 data and no data from this campaign are fit inputs.**

### 5.2 Frozen nominal prediction (**scored**)
| RPS | Breach if sustained? | Error % | HTTP P95 ms | DB CPU % | Dominant failure class |
|---:|---|---:|---:|---:|---|
| 300 | no | 0.336783 | 44.91 | 14.93 | other |
| 500 | no | 0.336783 | 63.79 | 26.40 | other |
| 700 | no | 0.336783 | 94.22 | 39.10 | other |
| 900 | no | 0.469202 | 146.30 | 53.01 | other |
| 1100 | no | 0.469202 | 245.75 | 68.13 | other |
| 1300 | no | 0.469202 | 473.34 | 84.48 | other |
| **1500** | **yes** | **12.226564** | **1,282.84** | **99.70** | **`queue_full`** (conditional mechanism: DB-limited) |

- **First breach: 1500 RPS** on the error criterion (P95 stays below 2,000 ms), with `queue_full` dominant. The breach is conditional on three complete consecutive stationary steady minutes.
- **Headroom at 1300 [DERIVED]:**
  - error 0.47% against 5%;
  - P95 473 ms against 2,000 ms;
  - DB CPU 84.5%, just under the 85% mechanism threshold.

### 5.3 Unscored fold ranges (disclosed; **not scored**)
The four saved fold parameter sets give the ranges below (excluding nominal). They are not confidence intervals. **No fold may be selected after the results.**

| RPS | Error % range | HTTP P95 ms range | DB CPU % range |
|---:|---|---|---|
| 1300 | 0.077–0.229 | 188–422 | 74.97–81.35 |
| 1500 | 0.077–12.015 | 362–1,189 | 88.85–97.54 |

Full per-rung ranges are in the frozen JSON. At 1500 some folds predict no breach; this is disclosed and does not change H1/H0.

### 5.4 Hypotheses (per rep, then campaign)
Each rep is evaluated with its first breach rung B, using §3.1. B = "none" if all 7 rungs complete without a qualifying breach.

- **H1, per rep (pass):** **B = 1500 exactly.** There is no qualifying breach at 300–1300 and a qualifying breach at 1500, by any criterion (error or P95).
  - [DECISION] The first-breach rung must match **exactly**.
  - A breach at 1300 or below is H0, even though it is "close".
  - Mechanism does not enter H1/H0 (§5.5a).
- **H0, per rep (fail):** **B = none** (no breach through 1500), **or B < 1500** (first breach at any lower rung).
- **Campaign verdict:**
  - **H1** if both valid reps are H1.
  - **H0** if both valid reps are H0. This includes mixed H0 forms, e.g. one rep with no breach and one with a breach at 1300.
  - **Not decided** if the reps split H1/H0, or if fewer than 2 valid reps remain after the §7.2 replacement rules. No third rep.
- **Always reported (descriptive):**
  - per-rung error %, P95, and steady-mean and peak DB CPU against §5.2;
  - `queue_full` and `too_many_connections` shares (of all responses and of failures);
  - pool-wait P95, max `Threads_connected` and prepared-statement peak.

### 5.5a Mechanism check (preregistered reporting label; never changes H1/H0)
At each rep's observed qualifying breach rung:

- **DB-limited** if **both** hold:
  - the whole-steady DB CPU mean through the actual stop is **≥ 85%**;
  - the **uniquely** dominant failure class is `queue_full` or `too_many_connections`.
  
  "Uniquely dominant" means the largest of the four exhaustive classes (`queue_full`, `too_many_connections`, `internal`, other) over the same whole steady window, including partial boundary minutes.
  - Ties do not establish dominance.
  - There is **no** > 50% majority requirement. This differs from r5xl-v1 §5.4 and follows the v4 freeze.
- **Otherwise app-limited, mechanism not decided.** This covers missing CPU or class data, a tie, CPU < 85%, or `internal`/other dominant.
  - It is a reporting label, **not proof of app causation**.
  - Peak CPU, app CPU or a single selected minute may not be substituted.
- **No breach:** mechanism not decided. No claim is made outside the ladder.
- The mechanism label never overrides harness validity (§5.5).
- DB-family transfer label: every result is reported as a **DB-family transfer test** (r5-calibrated, no family term), not as m5 calibration.

### 5.5 Rep validity (as r5xl-v1 §5.5, E1 class changed)
- **E1:** wait-ready `SHOW GLOBAL VARIABLES` shows `max_prepared_stmt_count` = 65528 and `max_connections` = 500, **and** the recorded RDS instance class is **db.m5.xlarge** with **4 vCPU** (§4).
- **E2–E5:** as r5xl-v1 §5.5.
  - Includes the no-breach coverage definitions.
  - **E5-pre** applies to rungs below the breach rung, and to every rung if there is no breach: strict dropped / (completed + dropped) ≤ 0.005 over the whole rung, warmup included, and generator CPU steady mean ≤ 70%.
  - **E5-breach** applies at the breach rung: generator health, stop marker, k6 exit 105 or 0, only the interrupt `level=error` line, no pre-breach harness error.
  - Both dropped ratios are reported descriptively.
- **Invalidity rules** are as r5xl-v1 §5.5: the post-breach harness-failure rule applies, and "invalid is not a pass or fail".
- **A wrong DB instance class or vCPU count makes the rep invalid** (reported, not scored).

## 6. Scoring
No new scorer.
- Per-rung records come from `score_dbsat_v1.record_from_collect` and `db_pressure`.
- An independent §3.1 recomputation from raw k6 is run as in `typical/dbsat-cpu-2x-r5xl-v1/results/holdout-20261023/recompute_breach_minutes.py`.
- H1/H0 is a lookup using §3.1, §5.4 and §5.5. It is done by an evaluation script committed with the results, adapted from `evaluate_cpu_r5xl_v1.py`:
  - hypotheses replaced by §5.4 (exact B = 1500);
  - the §5.5a mechanism label added;
  - the no-breach path exercised.
- r5xl-v1 data appear only as a separate descriptive comparison.

## 7. Operations
### 7.1 Runner autonomy
As r5xl-v1 §7.1: the existing **stopped** independent AWS runner is started for this campaign and stopped, not terminated, afterwards.

### 7.2 Budget and replacements
- **Soft cap $25.** At the cap, **pause and ask Kevin**; never auto-stop.
- Up to 3 replacements, only for invalid reps, with a next-letter suffix. A workload breach is valid evidence and never authorizes a replacement.
- [DERIVED] Spend estimate. db.m5.xlarge is cheaper per hour than db.r5.xlarge.
  - A breach-at-1500 rep runs about 6.5 rungs (≈ 2.2 h of load plus apply/destroy).
  - Estimate **≈ $2–3 per rep, ≈ $4–6 for 2 reps**; worst case with 3 replacements ≈ $15, under $25.

### 7.2a After load, recovery is cleanup only
As r5xl-v1 §7.2a.

### 7.3 Cleanup and redaction
As r5xl-v1 §7.3:
- Destroy after each apply.
- Run immediate and ≥ 15-minute delayed cleanup checks in us-east-2 and us-west-2.
- Redact before publication: account ID and ARNs, public IPs, RDS endpoint and resource IDs, ALB DNS, EC2 instance and volume IDs (including file/directory names), SSM command IDs and runner paths.
- Raw k6 gzips stay off-repo.

## 8. Required changes before the first apply (no app/load change)
1. **Repo.** None. `db_instance_class` is already a Terraform variable, and the `Topology` tag renders from it (r5xl-v1 §8.1).
2. **Runner-side controller (not in this repo).** Start from the r5xl-v1 controller (SHA256 `fed63760a38c1191feea485af4aa369d5bbdadd682ca246359496d0e2a8806ef`, manifest `b1d51ace…cde1`). Make only these changes:
   - (a) pass `-var db_instance_class=db.m5.xlarge`, and gate the AWS-reported class = db.m5.xlarge and 4 vCPU at wait-ready (E1);
   - (b) accept this campaign's IDs (§9) and refuse any journaled ID;
   - (c) compute the §5.5a inputs in the run summary (descriptive; scoring recomputes);
   - (d) no other harness change.
   
   Required offline tests:
   - a db.r5.xlarge (wrong-class) fixture fails E1;
   - a breach-at-1500 fixture scores H1;
   - a no-breach fixture and a breach-at-1300 fixture each score H0;
   - mechanism fixtures cover CPU 85.0% with `queue_full` uniquely dominant (DB-limited), CPU 84.9% (app-limited), and a tie (app-limited).
   
   Run the full offline suites plus an EC2 no-load rehearsal on the exact final manifest, with cleanup passing in both regions.
3. **Frozen harness/runner manifest [TBD by the runner; effective upon merge of the §8.3 update].**
   - Manifest SHA256: `TBD`
   - Controller SHA256: `TBD` (predecessor `fed63760a38c1191feea485af4aa369d5bbdadd682ca246359496d0e2a8806ef`)
   - Offline suite counts, rehearsal times, cleanup times, rehearsal archive SHA256 and test-log SHA256: `TBD`
   - Any later harness-only change means a new manifest SHA, recorded as a deviation under §7.1.
4. The wiring commit is `main` at freeze, with `git diff 881e0cf -- app-typical/ load/` empty.

## 9. Names and paths
- `typical/dbsat-cpu-2x-m5xl-v1/PREREGISTRATION.md`
- Applies: `typical-dbsat-pscap-2x-r{1,2}[letter]-YYYYMMDD` (pscap 2× family, which carries the 65,528 gate).
  - **No apply ID may reuse any journaled ID.** This includes all v1, v1.1 and r5xl-v1 IDs and the r5xl-v1 rehearsal ID.
  - The controller refuses journaled IDs. The chosen IDs are disclosed as initial reps.
- Parent ID: `typical-dbsat-cpu-2x-m5xl-v1-YYYYMMDD`
- Evidence: `typical/campaign/typical-dbsat-cpu-2x-m5xl-v1-<date>/`
- Results: `typical/dbsat-cpu-2x-m5xl-v1/results/`

## 10. Risks
- **Exact-rung requirement.** At 1300 the nominal DB CPU is 84.5% and error is 0.47%, but in r5xl-v1 rep 2 one 1300 minute reached 5.5% error. A breach at 1300 on m5 (less memory, same vCPU) is plausible and would score H0.
- **Fold disagreement at 1500.** Some folds predict no breach at 1500, so no breach through 1500 is also plausible.
- **Memory.** m5 has half the memory of r5. If the buffer pool matters, I/O wait may rise; this is outside v4 (no family term).
- **Generator at 1500.** In r5xl-v1 rep 2 the strict dropped ratio at 1500 was 0.0067 (descriptive at a breach rung). If the generator falls behind before any breach, E5-pre fails and the rep is invalid, not H0.
- **Instance availability.** A launch failure is a pre-workload retry under §7.1.
- Reps may disagree; the result is then not decided.

## 11. Changelog
- r1 (2026-10-24): initial draft from r5xl-v1. Changes: DB class, frozen prediction reference/hashes, hypotheses (exact B = 1500), §5.5a mechanism check, DB-family transfer label, §8.3 TBD.
