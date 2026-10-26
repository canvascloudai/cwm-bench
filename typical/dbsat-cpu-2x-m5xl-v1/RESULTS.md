# typical/dbsat-cpu-2x-m5xl-v1 — Results

**Verdict: H1.** Both valid reps (replacement rep 1 `r1b`, rep 2 `r2`) had their first qualifying breach at exactly **1500 RPS**, on the error criterion: 16.1 / 15.3 / 15.4% (rep 1) and 7.7 / 9.8 / 10.2% (rep 2) across the three breach minutes. P95 stayed below 2,000 ms, at about 940–1,035 ms. 300–1300 completed with no breach in both reps. The frozen v4 nominal prediction (§5.2, freeze `083bb0c6…d598`) was **first breach at 1500**, so it holds.

**Mechanism (§5.5a): DB-limited in both reps.** Whole-steady DB CPU through the stop was 96.2% / 93.8% (≥ 85%), and `queue_full` was uniquely dominant (78.8% / 75.6% of failures). This label is a reporting label and does not change H1/H0. Every result is reported as a **DB-family transfer test** (r5-calibrated, no family term), not as m5 calibration.

This is scored strictly against `PREREGISTRATION.md` on `main`, including the §5.5b validity precedence and the PR #44 readiness-only addendum, and against the nominal §5.2 prediction only. No sensitivity variant was selected, and nothing was tuned after the results were seen.

## Provenance (verified)
- **Archive.** Stored as 95 parts in the owner's private Drive.
  - Every part matches `SHA256SUMS`.
  - The reassembled SHA256 is `b06552bab40bde0ad44fecc09ae3da6a92970cf71e39c9a4a04cbff029667380`, recomputed and matching.
  - All 552 entries in the archive's internal `FILES.sha256` verified.
- **Freeze receipt.**
  - The recorded wiring commit `39aa828f` is the merge of PR #44 (readiness-only addendum) on `main`.
  - The archived `PREREGISTRATION.md` is byte-identical to the file on `main`.
  - The recorded manifest `553ad557…45a3` and controller `b2b4590a…b9f3` equal the values named in the PR #44 addendum. Measurement content basis `881e0cff`. The manifest and controller derivations were not reproduced for this results PR.
- **Hardware (E1).** For both scored reps, the AWS-reported class is `db.m5.xlarge`, with `DefaultVCpus` = 4 from the paired capacity lookup. Wait-ready `max_prepared_stmt_count` / `max_connections` = 65528 / 500.
- **Ladder.** 300 / 500 / 700 / 900 / 1100 / 1300 / 1500 RPS, on 2 app nodes, with a fresh apply for each rep. There were no rung retries.
- **Rep IDs (disclosed).**
  - `typical-dbsat-pscap-2x-r1a-20261024`: original rep 1. Preserved as an **unscored runner-fault replacement candidate** (see below).
  - `typical-dbsat-pscap-2x-r1b-20261025`: owner-approved replacement rep 1 (`replacement: true`). 1 replacement was consumed.
  - `typical-dbsat-pscap-2x-r2-20261025`: rep 2 (`replacement: false`).
  - The apply IDs keep the historical `pscap` naming used by the controller; the campaign is `typical-dbsat-cpu-2x-m5xl-v1`.

## Validity (§5.5 / §5.5b): both scored reps valid

| Check | Rep 1 (`…-r1b-20261025`) | Rep 2 (`…-r2-20261025`) |
|---|---|---|
| E1 class / vCPU / `max_prepared_stmt_count` / `max_connections` | db.m5.xlarge / 4 / 65528 / 500 | db.m5.xlarge / 4 / 65528 / 500 |
| Runner E1–E5 evidence gate | all true, `intact`, no reasons | all true, `intact`, no reasons |
| E5-pre strict dropped ratio 300…1300 (≤ 0.005) | max 0.00140 (1300) | max 0.00083 (1300) |
| E5-pre generator CPU steady mean (≤ 70%) | 5.8 … 21.4% | 5.9 … 21.5% |
| E5-breach: CPU minutes ≤ 70%, none missing | yes (max 24.5%) | yes (max 25.1%) |
| E5-breach: stop marker, k6 exit, only the interrupt `level=error` line | yes (`breach`), exit 105 | yes (`breach`), exit 105 |
| Harness failure before the declaration | none | none |
| Breach-rung strict dropped ratio (descriptive; not an E5-breach input) | 0.0048 | 0.0040 |

- The post-breach `recovery failed` at 1500 in both reps (DB connections held at about 498 for the 15-minute window while DB CPU fell to about 1.5%) happened after the declaration. Recovery after load is cleanup only, so it does not affect validity (`validOverloadEvidence: true`).
- **Cleanup.** Immediate and ≥ 15-minute delayed checks passed in us-east-2 and us-west-2 after each rep, with `liveCleanupConfirmed` true. `strictTagInventoryEmpty` was false (inventory showed terminated or not-found items only).

### Original rep 1 (`…-r1a-20261024`): not scored
- Recorded outcome: holdout harness/infrastructure failure. Rung readiness failed before 1300 (the SSM `InvocationDoesNotExist` fault addressed by the PR #44 addendum). 300–1100 completed and were collected; 1300 never started. Its post-run evidence gate had E4 false and `intact` false.
- Per PR #44 it is preserved as a runner-fault replacement candidate, **not automatically invalid**, and it is **not scored** here.
- Descriptively, its 300–1100 rungs had no breach and closely match `r1b`/`r2` (error ≤ 0.04%, P95 27–312 ms, DB CPU 13.7–63.7%). Its `breach-typical-dbsat-2x-1100.jsonl` is the normal per-minute breach-monitor log, with no over-limit minute.

## Scoring (§3.1, §5.4)
The breach was recomputed independently from the raw k6 gzips (`recompute_breach_minutes.py`). It agrees with the runner's breach monitor on the rung and the three minutes in both reps.

| RPS | Rep 1 err % | Rep 1 P95 ms | Rep 1 DB / app CPU % | Rep 2 err % | Rep 2 P95 ms | Rep 2 DB / app CPU % | §5.2 err % / P95 / DB CPU |
|---:|---:|---:|---:|---:|---:|---:|---|
| 300 | 0.001 | 16 | 12.8 / 17.0, 16.1 | 0.005 | 10 | 13.1 / 16.3, 16.2 | 0.337 / 45 / 14.9 |
| 500 | 0.022 | 77 | 22.6 / 28.1, 28.5 | 0.022 | 74 | 21.7 / 28.6, 27.8 | 0.337 / 64 / 26.4 |
| 700 | 0.027 | 104 | 34.3 / 40.6, 39.7 | 0.014 | 105 | 32.5 / 40.6, 39.8 | 0.337 / 94 / 39.1 |
| 900 | 0.022 | 170 | 48.5 / 53.0, 52.8 | 0.030 | 158 | 45.9 / 51.7, 51.6 | 0.469 / 146 / 53.0 |
| 1100 | 0.033 | 339 | 66.4 / 65.4, 65.7 | 0.028 | 288 | 61.8 / 66.1, 64.9 | 0.469 / 246 / 68.1 |
| 1300 | 2.28 | 807 | 89.3 / 80.4, 82.0 | 0.49 | 634 | 81.0 / 81.9, 80.1 | 0.469 / 473 / 84.5 |
| **1500** | **15.37 (breach)** | 1,017 | 96.2 / 86.3, 90.3 | **9.02 (breach)** | 934 | 93.8 / 87.9, 89.3 | **12.23 (breach) / 1,283 / 99.7** |

- How the columns are computed:
  - Error % and P95 are over all phase=steady points. P95 is nearest-rank.
  - DB CPU is the CloudWatch 1-minute `CPUUtilization` steady mean, overlap-weighted including partial boundary minutes (the §5.5a input).
  - App CPU is the per-node EC2 `CPUUtilization` steady mean, overlap-weighted the same way. It is descriptive only and not a §5.5a input.
  - At 1500 the steady window ran only up to the breach stop: 3 full minutes plus partial minutes.
- **Breach minutes (UTC):**
  - Rep 1: 14:51, 14:52, 14:53, declared at 14:54:07 on 2026-10-25.
  - Rep 2: 21:30, 21:31, 21:32, declared at 21:33:08 on 2026-10-25.

**Failure classes, share of steady failures (descriptive; the 1500 row is the §5.5a input):**

| RPS | Rep 1 queue_full / TMC / internal / other | Rep 2 queue_full / TMC / internal / other |
|---:|---|---|
| 300–900 | 0 / 0 / 0 / 100% (a few 502) | 0 / 0 / 0 / 100% |
| 1100 | 2.7 / 18.2 / 0.9 / 78.1% | 0.4 / 0 / 0 / 99.6% |
| 1300 | 59.6 / 29.9 / 8.5 / 2.0% | 66.1 / 16.8 / 8.3 / 8.8% |
| 1500 | **78.8** / 11.6 / 9.4 / 0.2% | **75.6** / 14.8 / 8.9 / 0.7% |

| | Predicted (§5.2) | Rep 1 | Rep 2 |
|---|---|---|---|
| First breach rung B | 1500 | **1500** | **1500** |
| Criterion | error (P95 < 2,000) | error (P95 < 2,000) | error (P95 < 2,000) |
| Dominant class at B | `queue_full` | `queue_full` 78.8% | `queue_full` 75.6% |
| DB CPU steady mean at B | 99.7% | 96.2% | 93.8% |
| §5.5a mechanism | DB-limited (conditional) | **DB-limited** | **DB-limited** |
| **Per-rep verdict** | | **H1** | **H1** |

**Campaign: H1** (both valid reps are H1).

## Measured vs predicted (descriptive; not scored)
- **At 1500.** The rung and the class match. Error bracketed the prediction (15.4% / 9.0% against 12.2%). P95 was lower than predicted (1,017 / 934 ms against 1,283 ms), and DB CPU slightly lower (96.2 / 93.8% against 99.7%).
- **300–1100.** DB CPU tracked the prediction within about −1 to −7 pp. Errors were far below the predicted floor (0.001–0.033% against 0.34–0.47%). P95 was close at 300–900 and above the prediction at 1100 (288–339 ms against 246 ms).
- **1300 headroom.** It was thinner than predicted. Rep 1 reached 2.28% error, 807 ms P95 and 89.3% DB CPU (against 0.47%, 473 ms, 84.5%), with `queue_full` already dominant. Rep 2 was closer (0.49%, 634 ms, 81.0%).

## Anomalies and disclosures
- **Rep 1 1300 partial minute.** The runner's breach monitor marked the 14:12 UTC minute as eligible and over the limit (6.97% error over 8,481 responses). That minute held only about 6 s of steady traffic after the steady phase ended at about 14:12:06. The raw recompute treats it as ineligible (not a full steady minute under §3.1). It was the last minute of the rung and its streak reached only 1, so neither reading changes the result. The recompute's highest eligible 1300 minute was 3.39%.
- Scope notes carried over from the PR #44 review: the pinned adapter could not be checked publicly here, and the readiness wrapper uses its own hard-coded SSM timeouts (within the addendum's windows).

## Files
`results/holdout-20261025/`:
- `recompute_breach_minutes.py`: the r5xl-v1 independent §3.1 recompute from raw k6, changed only to key reps by apply suffix (`r1a`/`r1b`/`r2`) and to mark `r1a` unscored.
- `breach-minutes.json`: its output for all three applies.
- `rung-tables.json`: the per-rung tables above, from the runner's descriptive summaries, plus the §5.2 prediction.
- `verdict.json`: the §5.4/§5.5a lookup.
- `gate.json`: an excerpt of the runner's E1–E5 evidence gates, redacted.

To reproduce, run from this directory: `python3 recompute_breach_minutes.py EVIDENCE`.

The raw archive is private. AWS account IDs, ARNs, instance/volume/resource IDs (including directory names), IPs, endpoints and runner paths are redacted from everything published here.
