# typical-dbsat-pscap-v1 holdout results (2026-10-17)

These are redacted results for the prepared-statement-limit holdout preregistered in `../../PREREGISTRATION.md`. The only change from the dbsat-v1 4× configuration is `max_prepared_stmt_count` = 65528. Cloud account, resource IDs, IPs, hostnames and private paths are replaced (see `REDACTION.md`). Raw k6, app, bootstrap and SQL logs, Terraform state and console logs stay private.

## Summary
- **Measured outcome:** both reps meet all three frozen H1 conditions (§5). There were zero MySQL errno 1461 errors, both reps breached at 900 RPS (above 700), and peak `Prepared_stmt_count` was 29,824 against the 65,528 limit.
- **Validity decision:** rep 1 had a harness failure after its breach. It is **retained as a disclosed exception** to the preregistered invalid-rep rule (§5), because every input the verdict depends on is intact.
- **Verdict with rep 1 retained: H1 (mechanism confirmed).**
- **Strict alternative:** applying §5's blanket harness-failure exclusion leaves one valid rep. The campaign would then be **not decided**.
- **Where 4× breaks now:** at 900 RPS, on the MySQL server-wide `max_connections` = 500 limit (`503/too_many_connections`, MySQL errno 1040), not on the app connection pool.

## Integrity
- The private campaign archive arrived as 25 parts plus `MANIFEST.json` and `SHA256SUMS`. All parts verified (OK).
- **Private original**, reassembled: SHA256 `06787143a17241d087a6fd8b57e0ee42f722ef6fc2b9d2aa6dc0e87420ea3daa` (matches the runner), 577,021,826 bytes, 218 files. Its internal `FILES.sha256` (217 entries) passes, and all 10 raw k6 gzips verify (`RAW-GZIP-VERIFICATION.json`).
- **The public archive is a redacted derivative with new hashes**, not the original. See `REDACTION.md` for its SHA256, the regenerated file list (`evidence/archive-FILES.sha256`) and the gzip hash list (`evidence/RAW-GZIP-VERIFICATION.json`).
- **Scorer:** unchanged `typical/dbsat-v1/score_dbsat_v1.py` on cwm-bench `main` @ `b4d05afb`. It uses `record_from_collect`, `request_outcomes_from_k6`, `steady_span_from_k6` and `db_pressure`.
- **§5 lookup:** `evaluate_pscap_v1.py`, which reads `rung-tables.json` and writes `verdict.json`.
- Run on the redacted tree, the scripts reproduce the same records and verdict as on the private original.

Reproduce (needs the extracted archive, including the k6 gzips, for `build_records.py`):
```bash
python3 build_rung_tables.py <archive>/typical-dbsat-pscap-v1-20261017 --out rung-tables.json
python3 evaluate_pscap_v1.py --tables rung-tables.json --out verdict.json
python3 build_records.py <archive>/typical-dbsat-pscap-v1-20261017 --out records.json
```

## 1. Measured outcome (prereg §5)
| Rep | B (breach rung) | 1461 total | Final complete rung | Last 5 `Prepared_stmt_count` samples, final complete rung | Limit reached? | H1.1 no 1461 | H1.2 B > 700 | H1.3 stays below the limit | H0(a) | H0(b) | Measured |
|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | 900 | 0 | 700 | 28,294 / 28,388 / 28,416 / 28,469 / 28,488 | no (apply max 29,803) | ✓ | ✓ | ✓ | no | no | **H1** |
| r2 | 900 | 0 | 700 | 29,822 ×5 | no (apply max 29,824) | ✓ | ✓ | ✓ | no | no | **H1** |

The global 1461 counter was 0 at the first and last 15 s sample of both applies. The parameter read 65528 at wait-ready (`SHOW GLOBAL VARIABLES`) and in every poll sample. Polling had 489 (r1) and 576 (r2) samples, with a largest gap of 15.2 s and no missing values. Neither polling-based invalid-rep rule applies.

## 2. Validity decision (disclosed exception)
- **What failed.** Rep 1's 900 RPS breach was declared at 18:16:08 UTC. At 18:18:06 UTC, about 2 minutes later, the controller failed while processing the stopped rung with `Persisted generator run boundaries missing`. The original failure record is `evidence/rep1-harness-failure-record.json`, and the recorded apply outcome is "holdout harness/infrastructure failure" (`evidence/campaign-execution.json`). As a result, rep 1 at 900 has no live collect and no recovery result.
- **What the rule says.** Prereg §5 lists "a dbsat-v1 §7.7 harness failure occurs" as an invalid-rep condition. It makes no exception for failures that happen after the breach.
- **Why rep 1 is retained.** Everything the H1/H0 lookup uses is intact:
  - the 15 s observer polls (no gaps through the breach and destroy);
  - the 65528 parameter check;
  - the per-minute breach-monitor rows that declared B = 900;
  - the original raw k6 gzip of the aborted rung, which was hash-verified before destroy.

  The missing live collect and recovery are not inputs to §5. The owner approved retaining rep 1 without a rerun (`evidence/rep1-retention-approval.json`). The 900 rung was reprocessed offline from the preserved gzip only, with no AWS calls and no rerun (`evidence/rep1-900-offline-reprocessing-receipt.json`).
- **Status.** This is a **disclosed exception to the preregistered validity rule**. It is not an exception-free pass.

## 3. Strict alternative
If §5's harness-failure rule is applied as written, rep 1 is invalid. Only rep 2 remains (H1). H1 requires both reps, so the campaign is **not decided** pending a replacement rep. `verdict.json` records both readings (`campaign_verdict`, `strict_alternative`).

## Per-rep, per-rung table
- **Steady P95** is nearest-rank over the raw k6 `http_req_duration` samples. "Scorer" uses the scorer's steady window. "Phase" uses all `phase=steady` points.
- **Errors** are steady-phase k6 `request_outcomes`.
- **Polls:** 1461, 1040, peak prepared statements and Threads_connected come from the 15 s observer polls over the rung window, warmup included.
- **Connections:** "CW conns" is the CloudWatch `DatabaseConnections` maximum. `max_connections` = 500.

| Rep | RPS | Status | Steady P95 ms (scorer / phase) | Achieved RPS | Error rate | Steady non-2xx outcomes | 1461 | 1040 | Peak `Prepared_stmt_count` | Threads_connected max | CW conns max | DB CPU % | PI AAS (io share) | Pool wait p95 ms | App CPU max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r1 | 300 | complete | 18.97 / 18.98 | 300.0 | 0.005% | 502/unclassified 13 | 0 | 0 | 7,821 | 154 | 152 | 32.0 | 0.60 (0.58) | 0.04 | 9.1 |
| r1 | 500 | complete | 80.59 / 80.59 | 499.6 | 0.003% | 502/unclassified 13 | 0 | 0 | 16,542 | 386 | 385 | 54.8 | 1.33 (0.64) | 0.03 | 14.4 |
| r1 | 700 | complete | 378.6 / 368.0 | 699.8 | 0.017% | 502/unclassified 57; 503/too_many_connections 44; 500/internal 5 | 0 | 32 | 28,488 | 500 | 498 | 84.3 | 17.5 (0.79) | 0.03 | 20.9 |
| r1 | 900 | breach stop, no live collect | unavailable / 2,073.2 | 880.4 | 17.20% | 503/too_many_connections 29,475; 500/internal 3,140; 503/queue_full 827; 502/unclassified 9 | 0 | 3,396 | 29,800 | 503 | unavailable | unavailable | unavailable | unavailable | unavailable |
| r2 | 300 | complete | 21.44 / 21.38 | 300.0 | 0.003% | 502/unclassified 9 | 0 | 0 | 5,260 | 108 | 107 | 30.2 | 0.51 (0.57) | 0.04 | 9.6 |
| r2 | 500 | complete | 84.60 / 84.06 | 500.0 | 0.003% | 502/unclassified 15 | 0 | 0 | 15,230 | 271 | 269 | 52.6 | 1.86 (0.64) | 0.04 | 15.4 |
| r2 | 700 | complete | 739.1 / 747.0 | 698.7 | 0.84% | 503/too_many_connections 4,678; 500/internal 576; 502/unclassified 41; 504/db_timeout 8 | 0 | 1,194 | 29,822 | 503 | 499 | 85.4 | 46.9 (0.41) | 0.03 | 21.8 |
| r2 | 900 | overload, 5 min | 1,525.1 / 1,540.8 | 889.7 | 20.08% | 503/too_many_connections 33,456; 500/internal 3,696; 502/unclassified 2 | 0 | 3,698 | 29,824 | 503 | 570 | 98.5 | 158.3 (0.63) | 0.03 | 25.1 |

Notes on the table:
- Rep 1 at 900 has no live collect, so its achieved RPS uses the k6 steady-phase span, which includes the drain after the stop.
- Rep 1 at 900 counts are **steady-phase** only. Warmup adds a further 3,023 `503/too_many_connections`, 353 `500/internal` and 1 `504/db_timeout`.
- Generator: on every rung with a validity record, CPU was ≤14.1% and dropped iterations ≤0.28% of scheduled. Rep 1 at 900 has no validity record; it dropped 3,773 iterations (0.40% of scheduled), and its generator CPU is unavailable.
- ALB ELB-5xx was ≤0.008% and there were 0 target connection errors on every collected rung.
- §6.2 pressure types (scorer `db_pressure`): none at 300 or 500. At 700 and at r2 900: cpu, io and connection-cap.

### Breach and recovery
| Rep | Breach minutes (UTC) | Declared (UTC) | Criterion | Per-minute error rate / P95 ms | Breach-time error snapshot | Recovery |
|---|---|---|---|---|---|---|
| r1 | 18:13, 18:14, 18:15 | 18:16:08 | errors (>5% in all three minutes); P95 >2,000 ms only in the third | 16.0% / 1,470; 16.4% / 1,591; 19.2% / 2,948 | +3.7 s: top code 1040 ER_CON_COUNT_ERROR (3,476 cumulative); no 1461 | unavailable (no live collect or recovery after the harness failure) |
| r2 | 21:32, 21:33, 21:34 | 21:35:08 | errors (>5%); P95 stayed below 2,000 ms | 17.8% / 1,501; 19.8% / 1,496; 21.3% / 1,562 | +3.5 s: 1040 (5,234 cumulative); no 1461 | failed on the connection rule only |

Rep 2's recovery shows DB CPU at 2.8–3.6%, AAS 0, and connections flat at 498 against an idle baseline of 0. This is the known recovery-rule artifact that prereg §3 says carries no weight.

## The 900 RPS breach mechanism (both reps, consistent)
- **Same dominant class in both reps:** `503/too_many_connections`, 15.2% (r1) and 18.1% (r2) of steady requests.
- **Server-side evidence:**
  - MySQL `ER_CON_COUNT_ERROR` (1040) rose from 0 to thousands, with no 1461.
  - `Threads_connected` was pinned at 503 (500 plus reserved administrative connections) against `max_connections` = 500.
  - The 4 × 250 app pools can request up to 1,000 connections.
- **App pool not the bottleneck:** pool wait p95 stayed at 0.03 ms.
- **Conclusion:** the breach is the **MySQL server-wide `max_connections` limit, not the app connection pool**. This is the next limit listed in prereg §10.
- **The DB was also saturated at 900** (r2: CPU 98.5%, AAS 158). In both reps the DB was already under cpu, io and connection-cap pressure at 700.
- **Secondary class:** `500/internal`, almost all on `POST /api/articles/:slug/comments`. MySQL raised no matching server-side error code in that window, and the pinned app does not log request-time errno. Its cause is therefore **unattributed**.
- 1040 counts are much smaller than 503 counts (r2 900: 3,698 vs 33,456). They are global server counters, and one refused connection can fail several queued requests, so the two are not 1:1.

Compared with dbsat-v1 4× (descriptive, never pooled): dbsat-v1 breached at 700 (r1) and 500 (r2) on `500/internal` with errno 1461 at the 16,382 limit. Here, 500 RPS ran with 0 application errors in both reps, and the breach moved to 900 on a different class.

## Observation: prepared statements per connection
This is descriptive (prereg §5) and not a model claim.
- At each rung's peak, `Prepared_stmt_count ÷ Threads_connected` was about 43–60.
- Once Threads_connected reached the 500 server limit, `Prepared_stmt_count` levelled off at about 29.8k (r1 700–900: 28,488 → 29,800; r2 700–900: 29,822 → 29,824).
- In this topology the count therefore stayed far below 65,528.
- At the observed ratios, the old 16,382 limit corresponds to about 275–380 open connections. Peak connections in the dbsat-v1 4× runs were 320–349.
- Which statements fill the cache stays unverified, because endpoint-level errno is unavailable.

## Deviations (all disclosed)
1. **Same-UTC-day reps.** The prereg says "on 2 different UTC days where possible". The owner approved running both on the same day, before rep 1 (`evidence/scheduling-disclosure.json`). Rep 2 was a fresh apply, started after rep 1's immediate and delayed cleanup passed in both regions.
2. **Rep 1 post-breach harness failure**, retained as a disclosed exception. See §2.
3. **Controller fix between reps.** This is harness-only and allowed under prereg §7.1 "proceed, then report". The fix rereads the persisted generator start/end boundaries after a breach stop settles, and rejects them if inconsistent (`evidence/rep1-to-rep2-controller.diff`).

   | Build | Used on | Manifest SHA256 | Controller SHA256 |
   |---|---|---|---|
   | pscap-1.0.0 | rep 1 | `b55f6fc3914e5d05ba0782b9ee8abc381fc1703e7fec147b785390b91800924f` | `19182a94b835b34a864f353917ed036a12aab26322e404e09afbe1687080361c` |
   | pscap-1.0.0-scheduling1 (same-day scheduling only; not applied on AWS) | none | `b33de0c80529325b463ea399001df35be4275cb256c3b3d0c5fb22ba0490ab01` | `4941e5af23c176861a43ae71d2acb812bf0189051dd6adcc8933495d69af11ba` |
   | pscap-1.0.1-boundaries | rep 2 | `b5ba224bba4ae4acff7115d048607124e7fb8f3b8ad8f4a261cd9615b5718b4a` | `d27be406bdf19b689b0f7dde86d8c29b76d0716da36fcf79d4a9292c905ee5f0` |

   - All three builds are controller-only and leave app and load code unchanged.
   - Final offline suites before rep 2:
     - controller 141/141
     - diagnostic 9/9
     - pscap 8/8
     - scheduling 6/6
     - boundaries 4/4
     - public Node 148 pass, 1 skip
     - Python 86 OK
   - Earlier failed suite attempts are retained in the private archive.
4. **Rep 1 at 900, offline reprocessing.** Steady P95 and request outcomes come from the preserved raw gzip (SHA256 `2cbdd0adb4a67c2d0e16082c8d0c84253f6ec8071c84c5739e664b3974d61e46`) with the pinned steady script. No collect, recovery, CloudWatch or PI data was reconstructed.
5. **Same SHAs on both applies:**
   - Wiring `b4d05afbc8ec7d61616af4231dc876443f2a5b81`, on every collect.
   - Measurement content `881e0cffd51da084be4a24ffd13366dfbb67063f`; `git diff 881e0cf -- app-typical/ load/` is empty.
   - Adapter 1.7.1. RDS `8.0.46-rds.20260908` (matches the pin). AMI `ami-0d3d85815a9746bc5`.

## Spend and cleanup
- Spend-guard upper bound: **$4.42** of the $25 soft cap. This is a conservative stack-hours estimate, not the AWS bill. **0 replacements.**
- Both applies were destroyed. Immediate and ≥15-minute delayed cleanup checks passed in us-east-2 and us-west-2. Stale tag-inventory entries were all classified as terminated or not found.

## Anomalies
- **CloudWatch vs server connections.** CloudWatch `DatabaseConnections` peaked at **570** in r2 at 900, above `max_connections` = 500, while the server-side `Threads_connected` peaked at **503**. CloudWatch likely also counts refused or handshake-stage attempts. The server value is used for the mechanism above.
- **Rep 1 900 P95 depends on the window.** 2,073.2 ms uses all `phase=steady` points, including completions during the drain after the 18:16:08 stop. Over [steady start, stop) it is 1,970.3 ms, and over the 4 whole minutes 18:12–18:16 it is 1,855.8 ms. The breach was declared on the error criterion, so B is unaffected.
- **Reps diverge at 700.** r2 was close to breaching (P95 739 ms, 0.84% errors, one minute at 2.7%, AAS 46.9). r1 was clean (P95 379 ms, 0.017%, AAS 17.5). Both had about 500 server connections at 700.
- **queue_full in rep 1 only.** r1 at 900 shows 827 steady `503/queue_full`; r2 at 900 shows none.
- **Known artifacts recur and are not scored:** the recovery connection rule (above). The AAS window-end null bug was not observed in any steady window.

## Files
| File | Content |
|---|---|
| `verdict.json` | §5 per-rep lookup, campaign verdict with rep 1 retained, and the strict alternative |
| `rung-tables.json` | §4.2 per-rung polling tables: 1461/1040 deltas, `Prepared_stmt_count` peak and last 5, Threads_connected, statements per connection |
| `records.json` | §4.1 per-rung records (unchanged scorer) plus phase-steady P95 |
| `evaluate_pscap_v1.py`, `build_rung_tables.py`, `build_records.py` | Evaluation scripts (prereg §6) |
| `diagnostic/r{1,2}/*.csv` | Per-minute `Prepared_stmt_count`, MySQL error deltas and HTTP outcomes, as exported by the runner (redacted) |
| `evidence/` | Original failure record, retention approval, offline reprocessing receipt, campaign execution summary, scheduling disclosure, controller diff, redacted archive file list and gzip hash list |
| `REDACTION.md` | Redaction method and the hashes of the redacted derivative |
