# typical-dbsat-conn-3x-v1 holdout results (2026-10-18)

These are redacted results for the 3× MySQL server-limit holdout preregistered in `../../PREREGISTRATION.md`. The holdout tests the frozen predictions of the recalibrated CWM server-limit candidate (unpublished, opt-in). Cloud account, resource IDs, IPs, hostnames and private paths are replaced (see `REDACTION.md`). Raw k6, app, bootstrap and SQL logs, Terraform state and console logs stay private.

## Summary
- **Verdict: H0** (§5.3). Both reps are valid (§5.4) and both are **H0(b)**.
  - Neither rep breached at 700 RPS. Both first breached at **900 RPS**, on the error criterion.
  - The prereg names a breach at 900 "a clear miss".
- **Measured outcome:** the 900 breach was on the MySQL server-wide connection limit in both reps:
  - `too_many_connections` (503) made up 89.9% of steady failures;
  - MySQL errno 1040 was raised about 4,000 times;
  - `Threads_connected` was 503 against `max_connections` = 500;
  - there were zero errno 1461 errors, and peak `Prepared_stmt_count` was 29,750 against 65,528.
- **At 700 RPS**, the rung where the breach was predicted, `Threads_connected` peaked at 442 / 434. The steady error rate was 0.008% / 0.013%, and P95 was 139 / 192 ms.
- **E5 caveat** (see "Validity"): both reps pass E5 under the definition the prereg cites. Under a stricter reading of "scheduled", both reps would be invalid and the campaign would be **not decided**, not H0.

## Integrity
- **Private campaign archive:**
  - It arrived as 24 parts plus `MANIFEST.json` and `SHA256SUMS`, and all parts verified.
  - Reassembled, its SHA256 is `faedd42b9964e0de12a62e47ceb68287f5b7891e0877219bb7fc64d12ddbbf9e` (matches the runner), at 573,779,059 bytes and 182 files.
  - Its internal `FILES.sha256` (181 entries) passes, and all 10 raw k6 gzips verify (`RAW-GZIP-VERIFICATION.json`).
- **The public archive is a redacted derivative with new hashes.** See `REDACTION.md`.
- **The prereg is frozen.** The `PREREGISTRATION.md` inside the archive is byte-identical to `main` at freeze (`9aee7d15`). The engine commit is recorded there (§5.1).
- **Scorer:** the unchanged `typical/dbsat-v1/score_dbsat_v1.py` (`record_from_collect`, `request_outcomes_from_k6`, `steady_span_from_k6`, `db_pressure`).
- **Evaluation:** `evaluate_conn3x_v1.py` is a lookup on §5.3 and §5.4. It reads `rung-tables.json`, `records.json` and the archive's `campaign-execution.json` / `RAW-GZIP-VERIFICATION.json`, and writes `verdict.json`.
- **Reproducibility:** run on the redacted tree, the scripts produce byte-identical `rung-tables.json` and identical records to a run on the private original.

Reproduce (needs the extracted archive; `build_records.py` needs the k6 gzips):
```bash
python3 build_rung_tables.py <archive>/typical-dbsat-conn-3x-v1-20261018 --out rung-tables.json
python3 build_records.py <archive>/typical-dbsat-conn-3x-v1-20261018 --out records.json
python3 evaluate_conn3x_v1.py <archive>/typical-dbsat-conn-3x-v1-20261018 --out verdict.json
```

## Per rep (§5.3)
| Rep | First breach B | Error rate, 3 breach minutes | TMC share at B | 1461 total | `Threads_connected` ≥ 490 first at | Peak `Prepared_stmt_count` (apply) | Outcome |
|---|---|---|---:|---:|---|---:|---|
| r1 | 900 | 10.09% / 11.64% / 9.66% | 89.9% | 0 | 900 RPS rung | 29,747 | H0(b) |
| r2 | 900 | 13.30% / 13.79% / 13.14% | 89.9% | 0 | 900 RPS rung | 29,750 | H0(b) |

Breach declarations were at 2026-10-18 16:21:07 UTC (r1) and 19:48:08 UTC (r2).

- **H1 fails on two conditions:** (1) the first breach was not at 700, and (5) the server limit was not reached by 700.
- **The other H1 conditions hold at the 900 breach:**
  - (2) the breach is on the error criterion;
  - (3) TMC share is above 50%;
  - (4) there are zero 1461 errors;
  - (6) every `Prepared_stmt_count` sample is below 65,528.
- **No other H0 clause applies:** not (a), (c), (d) or (e).
- **Campaign:** both valid reps are H0, so the campaign verdict is H0.

## Per rung
- Steady P95 and error rate come from `record_from_collect` over the steady window.
- Failure counts are steady-phase k6 `request_outcomes`, classed as in `request_outcomes_from_k6`.
- 1461 and 1040 Δ are the global errno counter deltas over the rung window.
- `Threads_connected` and `Prepared_stmt_count` come from the 15 s observer polls.
- The last column is the worst breach-monitor minute.

| Rep | RPS (per server) | Status | Steady P95 ms | Error rate | Steady failures: TMC / internal / other | 1461 Δ | 1040 Δ | Peak `Prepared_stmt_count` | Max `Threads_connected` | DB CPU mean % | Worst monitor minute error |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| r1 | 300 (100.0) | complete | 15.2 | 0.0059% | 0 / 0 / 16 | 0 | 0 | 4,390 | 79 | 26.1 | 0.022% |
| r1 | 500 (166.7) | complete | 68.6 | 0.0027% | 0 / 0 / 12 | 0 | 0 | 10,217 | 203 | 45.5 | 0.010% |
| r1 | 700 (233.3) | complete | 138.9 | 0.0078% | 0 / 0 / 49 | 0 | 0 | 25,145 | 442 | 69.8 | 0.026% |
| r1 | 900 (300.0) | **breach** | 1279.6 | 10.5697% | 17,069 / 1,916 / 11 | 0 | 3,995 | 29,722 | 503 | 86.9 | 11.640% |
| r2 | 300 (100.0) | complete | 17.6 | 0.0026% | 0 / 0 / 7 | 0 | 0 | 5,237 | 181 | 27.2 | 0.011% |
| r2 | 500 (166.7) | complete | 65.3 | 0.0089% | 0 / 0 / 40 | 0 | 0 | 10,642 | 225 | 47.9 | 0.033% |
| r2 | 700 (233.3) | complete | 191.5 | 0.0133% | 0 / 0 / 84 | 0 | 0 | 24,502 | 434 | 76.1 | 0.038% |
| r2 | 900 (300.0) | **breach** | 1399.3 | 13.4955% | 22,396 / 2,520 / 4 | 0 | 4,069 | 29,718 | 503 | 91.7 | 13.795% |

Below 900, every steady failure is classed `unclassified`; there are no `too_many_connections` responses.

**The 700 rung was not close to breaching.**
- The worst monitor minute was 0.026% / 0.038% errors, against the 5% criterion.
- P95 was 139 / 192 ms, against 2000 ms.
- There were no 1040 errors.

**After the 900 breach:**
- The recovery rule reported "recovery failed" in both reps. Its window starts after the declaration.
- CloudWatch `DatabaseConnections` stayed at 498–499 at idle. This is the recovery-rule artifact disclosed in pscap-v1, and it is not scored.
- At 900, CloudWatch `DatabaseConnections` maxima were 591 / 606, while the server's `Threads_connected` was 503. pscap-v1 showed a similar gap (570 vs 503).

## Frozen reference values vs measured (§5.2; reference values were not scored)
| RPS | Reference connections | Measured max `Threads_connected` r1 / r2 | Reference `Prepared_stmt_count` | Measured peak r1 / r2 | Statements per connection at peak r1 / r2 |
|---|---:|---:|---:|---:|---:|
| 300 | 229.8 | 79 / 181 | ~13,600 | 4,390 / 5,237 | 55.6 / 28.9 |
| 500 | 471.4 | 203 / 225 | ~27,900 | 10,217 / 10,642 | 50.3 / 47.3 |
| 700 | at the 500 ceiling | 442 / 434 | ~29,600 | 25,145 / 24,502 | 56.9 / 56.5 |
| 900 | — | 503 / 503 | — | 29,722 / 29,718 | 59.1 / 59.4 |

## Observations (descriptive; not part of the H1/H0 test)
- **Connections tracked total RPS, not RPS per app server.**
  - The frozen reference values read 3× connections off the 4× knots indexed by RPS per server, so 166.7 RPS per server (500 total) gave 471 connections. Measured: 203 / 225.
  - At the same **total** RPS, 3× used about as many connections as pscap-v1 4×, or fewer. The exception is r2 at 300 (181 against 154 / 108). 3× did not need the much higher counts that the per-server reading implies.
  - At 700, `Threads_connected` was 442 / 434, below the 490 server-limit threshold. With no 1040s there were no `too_many_connections` responses, and the error rate stayed far below 5%.
- **3× and 4× both broke at 900 on `max_connections` = 500.**
  - In both topologies the breach was on the error criterion.
  - In both, `too_many_connections` dominated, at 89.9% of steady failures in each 3× rep and about 88–90% in pscap-v1. `Threads_connected` was 503.
  - 3× was milder at 900: 10.6% / 13.5% errors against 17.2% / 20.1% on 4×.
- **The statement coefficient held.**
  - Near the connection plateau there were 56.5–59.4 statements per connection. The frozen coefficient is 59.10.
  - Peak `Prepared_stmt_count` was about 29.7k. The prepared-statement cap was never approached.
- **Error-share observations:**
  - With the server pinned at 503 (900 RPS), `too_many_connections` was 9.5% / 12.1% of all steady outcomes on 3×, and 15.2% / 18.1% on pscap-v1 4×. The frozen share above the limit is 15.35%.
  - In pscap-v1, 4× reached 500 / 503 connections at 700 RPS, but its error rate stayed at 0.017% / 0.84%. Reaching the server limit at a rung did not by itself push that rung above 5% errors.

Comparison with `typical-dbsat-pscap-v1` (4×, same parameters, `../../../dbsat-pscap-v1/results/holdout-20261017/`). The 4× r1 900 rung has no live collect, so its DB CPU is unavailable.

| Total RPS | 4× max `Threads_connected` r1 / r2 | 3× r1 / r2 | 4× error rate r1 / r2 | 3× r1 / r2 | 4× TMC / all outcomes r1 / r2 | 3× r1 / r2 | 4× DB CPU % r1 / r2 | 3× r1 / r2 |
|---|---|---|---|---|---|---|---|---|
| 300 | 154 / 108 | 79 / 181 | 0.005% / 0.003% | 0.006% / 0.003% | 0.000% / 0.000% | 0.000% / 0.000% | 32.0 / 30.2 | 26.1 / 27.2 |
| 500 | 386 / 271 | 203 / 225 | 0.003% / 0.003% | 0.003% / 0.009% | 0.000% / 0.000% | 0.000% / 0.000% | 54.8 / 52.6 | 45.5 / 47.9 |
| 700 | 500 / 503 | 442 / 434 | 0.017% / 0.843% | 0.008% / 0.013% | 0.007% / 0.744% | 0.000% / 0.000% | 84.3 / 85.4 | 69.8 / 76.1 |
| 900 | 503 / 503 | 503 / 503 | 17.200% / 20.077% | 10.570% / 13.495% | 15.156% / 18.079% | 9.497% / 12.128% | — / 98.5 | 86.9 / 91.7 |
E5 1 {'controller_dropped': 1721, 'controller_scheduled_full_step': 945000, 'controller_fraction': 0.0018211640211640212, 'k6_dropped': 1721.0, 'k6_iterations_completed': 314655.0, 'scheduled_until_stop': 316376.0, 'fraction_of_scheduled_until_stop': 0.005439729941588489, 'strict_until_stop_ok': False}
E5 2 {'controller_dropped': 2393, 'controller_scheduled_full_step': 945000, 'controller_fraction': 0.0025322751322751323, 'k6_dropped': 2393.0, 'k6_iterations_completed': 319143.0, 'scheduled_until_stop': 321536.0, 'fraction_of_scheduled_until_stop': 0.007442401472929936, 'strict_until_stop_ok': False}

## Validity (§5.4): both reps valid
- **E1:** wait-ready `SHOW GLOBAL VARIABLES` read `max_prepared_stmt_count` = 65528 and `max_connections` = **500** in both reps. The polls saw no other values during either apply.
- **E2:** breach-monitor rows are present for every rung through the declaration.
  - The only `dataGap` rows are the minute after each completed rung ends (0 requests) and the first minute of r1's 300 rung. None is in a breach window.
- **E3:** all raw k6 gzips through the breach rung are hash-verified against the original transfer.
- **E4:** no polls are missing, from the breach-rung start through the declaration + 60 s, or from the first rung onward (r1: 531 samples, r2: 530).
- **E5:** all pre-breach rungs are generator-valid. On the breach rung, dropped iterations were 1,721 (r1) and 2,393 (r2), which is **0.18% / 0.25%** of scheduled under the definition §5.4 cites. That definition is dbsat-v1 §7.5, where scheduled = RPS × 1050 s = 945,000 at 900. The collect's `dropped_ratio` gives the same value. Pass.
- **Parameters and failures:**
  - `max_prepared_stmt_count` = 65528 and `max_connections` = 500, as required.
  - The archive contains no harness or infrastructure problem records, and every run and teardown result is `ok: true`.
  - **The post-breach harness-failure rule and the timestamped problem records (§8.2(c)) were therefore not exercised in this campaign.**

### E5 denominator caveat
The breach rung stops early: after about 8.6 (r1) and 8.7 (r2) minutes, against the full 17.5-minute schedule. Measured against iterations actually scheduled until the stop (k6 completed + dropped: 316,376 and 321,536), dropped iterations are **0.54% (r1) and 0.74% (r2)**. Both exceed 0.5%.

- This reading is **not** the preregistered rule, and the verdict above uses the cited §7.5 definition. It is disclosed because "scheduled" is not restated for a partial breach rung.
- **Effect if it were applied:** both reps would be invalid. §5.4 says an invalid rep is not a result; it would go to the §7.2 replacement rules. With no valid reps, the campaign verdict would be **not decided**, not H0. `verdict.json` records this sensitivity (`sensitivity_E5_scheduled_until_stop`).
- **Measured outcome either way:** the breach rung is 900 in both reps, so the measured outcome (H0(b) in each rep) does not depend on this reading. Only the validity status does.

## Deviations
None from §2–§7.

- **Configuration:**
  - 3× m5.large with pool 250;
  - db.r5.large on MySQL 8.0.46;
  - one c6i.xlarge generator and the pinned AMI;
  - a fresh apply per rep;
  - apply IDs `typical-dbsat-pscap-3x-r{1,2}-20261018` (§9).
- **Scheduling:** both reps ran on the same UTC day, as the prereg allows. This is disclosed in `evidence/scheduling-disclosure.json`. r2 started only after r1's immediate and delayed cleanup checks passed.
- **Replacements:** none. The ladder stopped at 900 in both reps; 1100–1500 were not run.
- **Code and wiring:**
  - Wiring commit `9aee7d15` (`main` at freeze). `git diff 881e0cf -- app-typical/ load/` is empty.
  - Controller `conn3-1.0.0`, manifest SHA256 `c6ade740bc1dabc418382e7a898bc1398e6761f676d529b8698cac0298717465`, controller SHA256 `b75972e03de0d5558a35524332f3e68fe7b7139b07e7317b64e9437558320414`.
  - It was built from the pscap-v1 rep 2 controller `d27be406bdf19b689b0f7dde86d8c29b76d0716da36fcf79d4a9292c905ee5f0`, as §8.2 requires. The diff is `evidence/pscap-rep2-to-conn3-controller.diff`.
- **Offline suites:** the final preflight passed 412 tests with 0 failures and 1 skip, including the §8.2 suite (10/10) (`evidence/controller-offline-preflight.json`). An earlier logged attempt had 8 failing tests, which were fixed before the passing run.

## Spend and cleanup
- **Spend:** the spend-guard upper bound for the campaign was **$3.92** ("conservative estimate, not bill"), against the $25 soft cap. No pause was triggered and there were 0 replacements.
- **Cleanup:** immediate and ≥15-minute delayed checks confirmed no live resources in us-east-2 and us-west-2 after each apply. `strictTagInventoryEmpty` is false, as in pscap-v1.

## Anomalies
- **Low-load variance between reps:** at 300, `Threads_connected` was 79 (r1) vs 181 (r2), and statements per connection 55.6 vs 28.9.
- **CloudWatch vs server connections:** at 900, CloudWatch `DatabaseConnections` exceeded the server's `Threads_connected` (591 / 606 vs 503), as in pscap-v1.

## Files
- `verdict.json`: per-rep §5.3 conditions, the §5.4 validity checks, the campaign verdict and the E5 sensitivity.
- `rung-tables.json`: per-rung observer-poll tables, plus breach-monitor rows and E4 polling.
- `records.json`: per-rung records from the unchanged scorer, plus steady outcome counts, TMC share and k6 iterations / dropped.
- `build_rung_tables.py`, `build_records.py`, `evaluate_conn3x_v1.py`: the scripts above.
- `diagnostic/r{1,2}/`: per-minute `Prepared_stmt_count` / `Threads_connected`, MySQL errno deltas and HTTP outcomes.
- `evidence/`:
  - `campaign-execution.json`;
  - `scheduling-disclosure.json`;
  - `controller-manifest.json`;
  - `controller-offline-preflight.json`;
  - `pscap-rep2-to-conn3-controller.diff`;
  - `archive-FILES.sha256` and `RAW-GZIP-VERIFICATION.json` from the redacted derivative.
