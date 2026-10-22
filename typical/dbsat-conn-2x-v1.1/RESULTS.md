# typical/dbsat-conn-2x-v1.1 — Results

**Verdict: H0.** Both valid reps are **H0(c)**. Each rep first breached at the predicted 900 RPS rung, on the error criterion, and reached the server connection limit. But `too_many_connections` was only **14.6% / 22.1%** of failures at the breach rung, below the >50% that H1 requires. Most failures were app-side `503/queue_full`. The rung prediction held; the predicted mechanism did not.

Scored strictly against `PREREGISTRATION.md` on `main` (merge `ec3bb059`), using the §5.2 primary matrix only, with no sensitivity case chosen after the fact. There is no pooling with v1.

## Provenance (verified)
- Archive: `typical-dbsat-conn-2x-v1.1-20261022.tar.gz`, 25 parts in the owner's private Drive. The reassembled SHA256 is `56570a7ebb650ef2569a4aa39ee6d73a4d6593c8eff3223fe73d298fef7997a4`, recomputed and matching `SHA256SUMS`. Every entry in the archive's internal `FILES.sha256` verified.
- Freeze receipt: merge `ec3bb059f4684d0055144fb52e65ef26f14eec95`, manifest `3224461d…0021`, controller `52d8bc74…4434`, app/load diff empty, Kevin approval recorded.
- **Disclosed harness deviation (§7.1 harness-only "proceed, then report", §8.4).** The first rep 1 preparation failed before any Terraform apply: a pre-created empty staging directory made the Terraform plan fail. There were 0 rungs, cleanup passed in both regions, and no replacement was used. A fix touching two files (`cwm-bench-v11-scope.mjs` and its test) changed the executed manifest to `a115312fb83708e6e0f40eb44c9cccf3746fae6c63049030a7be6d62bdf1392a`. The controller is unchanged (`52d8bc74…`), and so are the measurement content `881e0cff`, app, load and workload. Suites after the fix: 556 passed, 0 failed, 1 skipped, and the rehearsal passed. This hash was not separately approved by Kevin; the prereg lets harness-only fixes proceed and be reported.
- Both reps ran on the same UTC day (2026-10-22). The prereg asks for different days *where possible*; this is disclosed and not a validity rule.

## Validity (§5.5): both reps valid

| Check | Rep 1 (`…-r1-20261022`) | Rep 2 (`…-r2-20261022`) |
|---|---|---|
| E1 wait-ready `max_prepared_stmt_count` / `max_connections` | 65528 / 500 | 65528 / 500 |
| E2 breach-monitor rows, every rung through the declaration | yes | yes |
| E3 raw k6 gzips (probe + 4 rungs) match download verification | 5/5 | 5/5 |
| E4 15 s polls: missing (max consecutive), breach rung / whole run | 0 (0) / 0.0% | 0 (0) / 0.0% |
| E5-pre strict dropped ratio, 300/500/700 (≤ 0.005) | 0 / 0.00014 / 0.0020 | 0 / 0 / 0.0015 |
| E5-pre generator CPU steady mean (≤ 70%) | 5.9 / 9.3 / 12.3% | 5.9 / 9.3 / 12.3% |
| E5-breach: CPU minutes ≤ 70%, none missing (max) | yes (15.9%) | yes (15.8%) |
| E5-breach: breach stop marker, k6 exit, only the interrupt error line | yes, exit 105 | yes, exit 105 |
| Harness error / stderr before the declaration | none | none |
| Cleanup, both regions (UTC): immediate / delayed | 06:13:29 / 06:28:27 passed | 11:20:12 / 11:35:03 passed |

## Scoring (§5.4, primary matrix)

| | Predicted (§5.2) | Rep 1 | Rep 2 |
|---|---|---|---|
| First breach rung B | **900** (none at 300/500/700) | **900** | **900** |
| Criterion (error > 5% in all 3 breach minutes) | error | error: 22.5 / 25.0 / 19.6% | error: 22.7 / 24.4 / 25.8% |
| TMC share of failures at B (H1 needs > 50%) | — | **14.6%** (5,764 / 39,569) | **22.1%** (11,498 / 52,126) |
| Top failure class at B | — | 503 `queue_full` 30,208 | 503 `queue_full` 36,075 |
| Server limit reached (max `Threads_connected` ≥ 490) | at 900 | yes, **from 700** (max 503) | yes, **from 700** (max 503) |
| errno 1461 total | 0 | 0 | 0 |
| Max `Prepared_stmt_count` (< 65,528) | 29,551 | 29,824 | 29,824 |
| **Per-rep verdict** | | **H0(c)** | **H0(c)** |

**Campaign: H0** (both valid reps are H0).

## Mechanism evidence (descriptive, not scored)
- **Processlist.** At wait-ready, both reps had 0 app connections, 1 observer, and 3 rdsadmin/system connections (`rdsadmin` 2, `event_scheduler` 1), so occupancy was cleanly established. The observer holds neither SUPER nor CONNECTION_ADMIN (not eligible for a reserved slot). Within about 2 s of the declaration, the breach snapshot showed 497 app connections, 1 observer and 3 system connections in both reps; rep 2 also had 2 `unauthenticated user` connections. `max_connections` was 500 throughout.
- **Prediction vs measurement.** The candidate expected 1 ordinary non-app connection; 4 were measured (observer plus system). Under §5.3 that is reported only and does not change the verdict.
- **Connections.** The server limit bound **one rung earlier than predicted**. `Threads_connected` reached 503 at 700 RPS in both reps, against a predicted 407 total. errno 1040 deltas at 700 were 2,414 and 925, yet there was no breach at 700: the error rate was 0.71% and 0.21%, and TMC was 0.39% and 0.14% of all responses (predicted 0.18%).
- **Rejection share.** At 900, TMC was 3.2% and 5.3% of all responses, against the candidate's 13.6%.
- **Other saturation.** DB CPU averaged about 99.7% and 99.4% at 900 (about 91–93% at 700). App CPU was about 45–53% per node. Pool-wait P95 was about 160–171 ms. The breach is dominated by app-side queue rejections (`queueLimit`) while the DB is CPU-saturated, not by server-connection rejections.
- Prepared statements per connection at peak were about 59.6.

## What this means
- The prediction of a first breach at the 900 rung was **right in both reps**, but H1 needs the mechanism too. The mechanism was not mainly server-connection rejections, so the candidate fails this holdout.
- The connection model under-predicts 2× demand: the limit was reached by 700. The ~13.6% rejection-share transfer (an assumption in §5.1) over-predicts.
- Per §5.4, H1 would have supported only rung plus mechanism. H0(c) refutes the mechanism component at 2×.

## Files
`results/holdout-20261022/`:
- `build_records.py` and `build_rung_tables.py`: the conn-3x scripts with `SERVERS = 2`, using the unchanged `score_dbsat_v1` scorer;
- `evaluate_conn2x_v11.py`;
- `records.json`, `rung-tables.json` and `verdict.json`.

The raw archive is private. AWS account, instance and ARN identifiers are redacted from everything published here.
