# typical/dbsat-pscap16k-2x-v1 — Results

**Verdict: H0.** Both valid reps (rep 1 = replacement `r1b`, rep 2 = `r2`) reached the predicted crossing `t*` and then hit errno 1461 **much later than `t*` + 1 poll**. Onset came 12 polls (180.1 s) after `t*` in `r1b` and 73 polls (1,095.0 s) after `t*` in `r2`. §5.4 needs `|onset − t*| ≤ 1` poll in both valid reps for H1, so the model is rejected on its stated timing. The zero-early-1461 condition did hold (0 errors before `t* − 1` in both reps), so the failure is "late", not "early".

This is scored strictly against `PREREGISTRATION.md` on `main` (PR #46, merge `d7153815`), using the 15 s observer polls, with no sensitivity variant and no tuning after the data were seen. Times below are UTC with America/New_York (ET, UTC−4) in brackets.

## What was predicted and what happened
Prediction (§5.1–5.2): the prepared-statement count follows `59.10268577018286 × Threads_connected`, so the 16,382 cap is reached at the first poll with `Threads_connected ≥ 278`, and 1461 starts within one poll of that.

| | Rep 1 (`r1b`, replacement) | Rep 2 (`r2`) |
|---|---|---|
| Valid (§5.5, E1–E8) | yes | yes |
| Predicted crossing poll `t*` | 2026-10-26 20:00:15.639Z (16:00:15 ET), poll #154 | 2026-10-26 23:00:07.191Z (19:00:07 ET), poll #200 |
| `Threads_connected` at `t*` / predicted `c × Threads` | 482 / 28,487 | 333 / 19,681 |
| Measured `Prepared_stmt_count` at `t*` | 12,414 (25.8 per connection) | 14,955 (44.9 per connection) |
| 1461 onset poll (§5.3) | 2026-10-26 20:03:15.742Z (16:03:15 ET), poll #166, counter 0 → 63 | 2026-10-26 23:18:22.229Z (19:18:22 ET), poll #273, counter 0 → 904 |
| Onset − `t*` | **+12 polls (+180.1 s)** | **+73 polls (+1,095.0 s)** |
| 1461 errors before `t* − 1` | 0 | 0 |
| Measured `Prepared_stmt_count` at onset | 16,382 (34.0 per connection) | 16,382 (49.2 per connection) |
| Peak `Prepared_stmt_count` / peak `Threads_connected` | 16,382 / 482 | 16,382 / 353 |
| §5.4 result | H0 (|onset − t*| > 1) | H0 (|onset − t*| > 1) |
| Breach rung (§3.1) | 700 RPS, declared 2026-10-26 20:35:10Z (16:35:10 ET) | 900 RPS, declared 2026-10-27 00:03:05Z (20:03:05 ET Oct 26) |

**Verdict rule check (§5.4):** both valid reps reached `t*` (so not NOT DECIDED), neither has `|onset − t*| ≤ 1`, hence **H0**.

## Per-rung table (descriptive, from the sealed per-rung summaries)
| Rep | Rung (RPS) | Max `Threads_connected` | Max `Prepared_stmt_count` | 1461 delta in rung | Failure rate | DB CPU (steady mean) | Breach |
|---|---|---|---|---|---|---|---|
| r1b | 300 | 177 | 6,438 | 0 | 0.01% | 29.1% | no |
| r1b | 500 | 482 | 16,382 | 4,911 | 1.10% | 49.8% | no |
| r1b | 700 | 482 | 16,382 | 13,663 | 5.93% | 69.0% | **yes** |
| r2 | 300 | 141 | 6,380 | 0 | — | — | no |
| r2 | 500 | 333 | 14,955 | 0 | — | — | no |
| r2 | 700 | 339 | 16,382 | 27,239 | 3.82% | 81.7% | no |
| r2 | 900 | 353 | 16,382 | 31,811 | 15.22% | 98.5% | **yes** |

"—" means the figure is in the sealed summaries but was not transcribed into this table.

## Breach mechanism
- **Error-rate criterion only; P95 was never the trigger.** I recomputed the three breach minutes directly from the sealed raw k6 output (`breach_from_k6.py`, outputs `breach-minutes-*.txt`), and they match the controller's declaration exactly:
  - `r1b` / 700 RPS: 5.61%, 5.55%, 5.95% failed (P95 ≈ 136–146 ms).
  - `r2` / 900 RPS: 16.32%, 14.79%, 14.56% failed (P95 ≈ 367–522 ms).
- Failures were HTTP 500 `internal`. Requests rejected for TMC (503), `queue_full` and errno 1040 (too many connections) were all 0.
- Errno 1461 (`max_prepared_stmt_count` exceeded) was **not seen before the prepared-statement count reached 16,382** in any poll, and it began in the same poll in which the count first read 16,382. That timing is observed.
- Attribution of the HTTP 500s to 1461 is **inferred**: the 1461 counter delta exceeds the 500 count and the app does not log the request-time errno. In `r2` / 900 RPS DB CPU was also about 98–99%, so DB saturation co-occurs with the 1461 errors there, and this data cannot separate the two.

## Why the prediction missed (descriptive, inferred)
- `Prepared_stmt_count` did **not** track `c × Threads_connected`. The measured count per connection at `t*` was 25.8 and 44.9, against the predicted 59.1, and `Com_stmt_close` stayed at 0.
- The count kept rising at an almost constant `Threads_connected` until it reached the 16,382 cap. In `r1b`, connections jumped from 178 to 482 within 15 s around 20:00:00Z, and the count then took about 3 minutes to reach the cap.
- So the 16,382 cap was hit when accumulated statements got there, not when the connection count crossed the threshold. This is a description of the 2 reps. It was not tested as a model and no new coefficient is fitted here.

## Validity (§5.5, E1–E8)
**Verified by me from the sealed archive:**
- **E6.** Live `max_prepared_stmt_count` is 16382 and in-sync at wait-ready, and every one of the polls in both reps reports 16382.
- **E7.** Largest gap between consecutive polls is 15.17 s (`r1b`) and 15.2 s (`r2`) over the whole series. The limit is 30 s from the first poll through onset + 1 poll.
- **E4.** 0 missing polls and 0 consecutive missing polls in both reps.
- **Hardware/topology/engine.** Match conn-2x-v1.1: 2 × m5.large app nodes, the DB class recorded at wait-ready, `max_connections` 500.
- **Breach declaration.** Recomputed from raw k6 data (see above).
- **Cleanup.** Immediate and delayed `cleanup-verification.json` have `liveCleanupConfirmed: true` for both reps.

**Runner-reported, spot-checked, not independently recomputed from raw data:**
- **E1–E3, E5.** Runner evidence gate `rep-evidence-gate.json` is intact. Dropped ratio ≤ 0.0015, generator CPU steady mean 5.9–14.4% and ≤ 17.6% in any minute, k6 exit 105 with only the interrupt `level=error` line.
- **E8.** `runnerFaultsInWindow: []`, exit codes 0.

**Inferred:**
- **Unlimited CPU credits throughout each window.** Unlimited mode is recorded at runner start (`credit-mode.json`), and continuity through each window is inferred, not separately sampled.

## Invalid, unscored applies
- `typical-dbsat-pscap16k-2x-r1-20261026`: stopped before Terraform apply and before any rung (exit code 3). Name derivation pointed at a nonexistent renamed readiness helper.
- `typical-dbsat-pscap16k-2x-r1a-20261026`: failed at observer readiness before any rung (`Invalid diagnostic directory`: the retained observer gate accepted only the previous campaign-ID family). 0 rungs. Destroyed, with both-region cleanup recorded.
- Both are pre-workload harness failures. Neither is scored. The original rep 1 (`r1`) failed first, so `r1a` and `r1b` are replacements 1 and 2 of the 3 allowed, and `r1b` is the valid rep 1. Since the 3-replacement allowance covers only invalid reps, this is within §7.

## Process deviations and disclosures
- **Changelog r2 was not committed before the run.** §8 promised that the manifest/controller SHA would be recorded in r2 before freeze. The runner kept r2–r5 as local, non-GitHub receipts under the owner's "no GitHub writes" instruction, and this results PR records them (see the changelog in `PREREGISTRATION.md`). The prereg text, predictions, thresholds and scoring on `main` were not changed.
- **Harness corrections r3–r5 happened before any scored rep** (listed in the changelog). The "r4 observer differs only in a directory-prefix literal" claim is the runner's. The predecessor observer is not in the archive, so I could not verify it.
- **E1 wording.** The parent §5.5 E1 text still says 65528; it is read here as 16382 via E6.
- **Spend.** The runner's own conservative upper-bound ledger (not a bill) shows `spentUpperBoundUsd` 3.44 after `r1b` and 6.30 after `r2`, against the $25 soft cap; `spendHistory` is empty and no actual billing figure was provided.
- **Disclosures in the prereg §10 still apply**: coefficient from the unpublished candidate `ffda3eba`, reused ladder, the 16,382 row never independently tested, and the publish scope is limited to the prepared-statement count model and the 1461 cap signal. The result does not support publishing the count model.
- **Sample size.** 2 reps, 1 configuration.

## Provenance and evidence
- **Raw archive** (not in git): `typical-dbsat-pscap16k-2x-v1-raw-20261027T012927Z.tar.gz`, 1,277,878,536 bytes, SHA256 `c0eb0633527592f9c3b48507688cb32f2be32b4e4941024188c9b7dc21f3476d`. It was transferred as 14 parts. Each part matched `PARTS.sha256` and the reassembled file matched `SHA256SUMS`.
- **Campaign manifest SHA256** (executed) `c728cec226f4c474ee5805cc95a77dd3f689cb918e505f818da4eece2d38f93f`; **controller SHA256** `1cace4511c217097718f321822b3bf037fd5dd5e538424fc27d7cb0ddcd3a110`; measurement SHA `881e0cffd51da084be4a24ffd13366dfbb67063f`; wiring SHA `d7153815a2782223b34c4db1ebde8bf17621ca05` (PR #46). The freeze receipt recorded `approvedByKevin: true`. I did not reproduce the manifest or controller derivations.
- **Redaction.** AWS account IDs, ARNs, instance/volume IDs and endpoints are not included in this PR. Only counts, timestamps and derived values are.
- **Files in `results/holdout-20261026/`:**
  - `scores.json`: the §5 scores per rep.
  - `poll-series-r1b.csv`, `poll-series-r2.csv`: per-poll `Threads_connected`, `Prepared_stmt_count`, `c × Threads`, and cumulative errno 1461/1040. Every poll is included, so every number above can be re-derived.
  - `score_pscap16k.py`, `build_scores.py`: the evaluation scripts (§6). Run `build_scores.py <attempts-dir> <outdir>` against the archive's `runner/attempts/`.
  - `breach_from_k6.py`, `breach-minutes-r1b-700.txt`, `breach-minutes-r2-900.txt`: per-minute failure rate and P95 recomputed from the raw k6 output for the two breach rungs. The first and last minutes listed are partial.
