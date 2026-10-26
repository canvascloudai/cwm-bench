# typical-dbsat-pscap16k-2x-v1: 16,382 prepared-statement cap holdout (preregistration)

**Status:** draft for review. This is not frozen and no apply is authorized until it merges. The merge commit is the freeze.
**Parent:** `typical-dbsat-conn-2x-v1.1` (`typical/dbsat-conn-2x-v1.1/PREREGISTRATION.md`, frozen at merge `ec3bb059`). Unless a section below says otherwise, every section of that prereg applies unchanged.
**Owner approval:** Kevin approved the plan on 2026-10-26.

## 1. Question
The candidate server-limit model (unpublished CWM candidate commit **`ffda3eba`**) failed `conn-2x-v1.1` on its connection hypothesis, H0(c). Its prepared-statements-per-open-connection coefficient did match the measurement, though: predicted 29,551 vs measured 29,824.

This campaign tests only that coefficient, together with the 16,382 cap signal (errno 1461), on a held-out configuration: the MySQL default `max_prepared_stmt_count = 16382` on the conn-2x-v1.1 topology.

## 2. Topology and the single intervention [DECISION]
- Everything is identical to conn-2x-v1.1 §2:
  - us-east-2, internal ALB, 2× m5.large app nodes on the same AMI;
  - workers 2, pool 250, queueLimit 50;
  - db.r5.large MySQL 8.0 at the same RDS engine version, `max_connections = 500` via the parameter group;
  - c6i.xlarge generator, `CWM_VU_PRE_S=0.5`, `CWM_VU_MAX_S=2.5`;
  - same app, load and adapter code.
- **The only change:** `mysql_max_prepared_stmt_count = 16382` (conn-2x-v1.1 used 65528). It is set explicitly in the parameter group. `wait-ready` verifies that the live value is 16382 and `in-sync` before any rung.
- AWS account, resource and ARN IDs are redacted in all committed evidence.

## 3. Ladder and breach [as parent]
- Rungs **300 → 500 → 700 → 900 → 1100 → 1300 → 1500 RPS**, each 300 s warmup + 900 s steady. This ladder is reused unchanged from conn-2x-v1.1.
- The §3.1 breach rule is unchanged: 3 consecutive eligible minutes with error > 5% or P95 > 2000 ms. Stop at the breach.
- **2 reps** (r1, r2).
- The breach rung is recorded descriptively. It is **not** scored here.

## 4. Measurements [as parent §4]
Observer polls run every **15 s** and record `Threads_connected`, `Prepared_stmt_count`, and the cumulative errno **1461** and **1040** counters from `performance_schema`. Raw k6, the app 500 bodies, and the InnoDB/error snapshot are recorded as in the parent prereg.

## 5. Frozen prediction and hypotheses [DECISION, frozen at merge]
### 5.1 Coefficient
- **c = 59.10268577018286** prepared statements per measured open server connection. It is taken from candidate commit `ffda3eba` without a refit.
- Predicted statements at a poll: **P̂(t) = c × Threads_connected(t)**.

### 5.2 Predicted crossing poll
- Within each rep, the **predicted crossing poll** t\* is the first 15 s observer poll, in time order across the rungs, where c × `Threads_connected` ≥ **16,382**.
- That means `Threads_connected` ≥ 278. [DERIVED: 16,382 / c = 277.18; 277 × c = 16,371 < 16,382; 278 × c = 16,431.]
- [DERIVED, descriptive only] From the candidate's connection curve, the crossing is expected around the 500–700 rung. This is not scored.

### 5.3 Measured onset
- The **measured onset** t₁₄₆₁ is the first observer poll where the cumulative errno 1461 counter is above its value at the rep's first poll.

### 5.4 Hypotheses
- **H1 (coefficient and cap signal hold):** in **both** valid reps, 1461 onset falls within ±1 poll (±15 s) of the predicted crossing, |t₁₄₆₁ − t\*| ≤ 1 poll, and **zero** 1461 errors occur before poll t\* − 1.
- **H0:** in at least one valid rep, the onset falls outside that window. H0 also holds if 1461 errors occur before t\* − 1, or if t\* is reached and no 1461 error occurs within t\* + 1.
- **H0 (no crossing):** a valid rep that breaches or ends without ever reaching t\* while 1461 errors occur counts as H0. A valid rep with neither a crossing nor any 1461 errors counts as untested. It is reported, and it counts toward NOT DECIDED.
- **NOT DECIDED:** fewer than 2 valid reps (§5.5) in which t\* was reached.

### 5.5 Validity
- E1–E5 are as in conn-2x-v1.1 §5.5, and E5-pre/E5-breach are unchanged.
- Additionally:
  - **E6:** the live parameter is 16382 and `in-sync` at wait-ready.
  - **E7:** no observer-poll gap longer than 30 s between the rep's first poll and onset + 1 poll. A gap makes the ±1-poll test unresolvable, so the rep is invalid.
  - **E8 (runner):** any runner-side fault before the scoring window ends makes the rep **invalid**. That includes runner CPU throttling, runner process or controller crash, and runner transport loss. Runner faults are never valid workload evidence.

## 6. Scoring
- An evaluation script is committed with the results, following the conn-2x-v1.1 pattern. For each rep it computes t\*, t₁₄₆₁ and the pre-onset 1461 count from the observer polls, then applies §5.4 and §5.5.
- **Descriptive only:** breach rung, TMC share, connection curve vs candidate, P95.

## 7. Operations [as parent §7, with these changes]
- §7.1 runner autonomy, §7.2a cleanup-only after load, and §7.3 cleanup and redaction are unchanged.
- **Runner CPU:** the runner stays in **unlimited CPU-credit mode** for the whole campaign. Its mode is restored to standard before stopping (not terminating) the runner, as in `dbsat-cpu-2x-m5xl-v1`.
- **Runner faults:** these count as invalid reps under E8. A replacement follows §7.2.
- **Budget:** soft cap **$25** (spend-guard upper bound). At the cap, **pause and ask Kevin**. Never auto-stop. Up to 3 replacements, only for invalid reps.
- [DERIVED] Spend estimate: comparable 2-rep campaigns spent $3.92 (conn-3x) and $4.42 (pscap-v1), so the expected range is ≈ $4–5 plus at most 3 replacements, which stays under $25.

## 8. Harness [pinned]
- **Measurement code:** `881e0cffd51da084be4a24ffd13366dfbb67063f` (unchanged).
- **Base harness (conn-2x-v1.1 lineage):**
  - frozen manifest SHA256 `3224461dbfd2ac7754e5133ae404100d767499fd92e7c9910e7108a603bc0021`;
  - executed manifest after the v1.1 harness fix: `a115312fb83708e6e0f40eb44c9cccf3746fae6c63049030a7be6d62bdf1392a`;
  - controller SHA256 `52d8bc74c4cd0adfb55b24b082f8a230ea73a1a40177eb426a9e5a4c5e184434`.
- **Latest harness-only successor (dbsat-cpu-2x-m5xl-v1 readiness addendum)**, which carries the unlimited-credit receipt check:
  - manifest `553ad5570ec2f63fe472d48ef046433ec7c95cfe7308cf1ba282517ec57045a3`;
  - controller `b2b4590a87d59eb96b513a376bc843f69d65e59c3140d2ab5493af0874aab9f3`.
- **Campaign harness:** this campaign runs the successor plus this PR's adapter change. That change is the pscap16k ID family and the 16382 wait-ready pin (`scripts/lib/adapter/ladder.mjs`, `ready.mjs`, `tests/adapter/dbsat-pscap16k.test.mjs`). The resulting manifest/controller SHA256 is recorded in r2 of this prereg **before freeze**. Any later change follows parent §7.1.
- **Candidate model:** `ffda3eba` (unpublished). It is pinned for the coefficient only.

## 9. Names
- Campaign ID: `typical-dbsat-pscap16k-2x-v1-YYYYMMDD`.
- Apply IDs: `typical-dbsat-pscap16k-2x-r{1,2}[letter]-YYYYMMDD`. IDs are never reused.
- Evidence: `typical/campaign/<apply-id>/`.

## 10. Disclosures and risks
- The coefficient comes from candidate commit **`ffda3eba`**. That candidate failed conn-3x-v1 (H0) and conn-2x-v1.1 (H0(c)). Only its statements-per-connection coefficient passed (29,551 predicted vs 29,824 measured).
- The **ladder is reused** from conn-2x-v1.1. It was not chosen independently for this question.
- The **16,382 row was never independently tested.** The dbsat-v1 2× discovery runs at 16,382 were not fit data and recorded no poll-level 1461 onset.
- **Publish scope:** only the prepared-statement count model and the 1461 cap signal are publish candidates. The candidate's connection, TMC and breach predictions are **not** publish candidates from this campaign, whatever the outcome.
- `Threads_connected` includes non-app sessions such as the observer and rdsadmin. The coefficient was fit the same way, so no correction is applied.

## 11. Changelog
- **r1 (2026-10-26):** initial draft.
