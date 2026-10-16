# typical-dbsat-v1 discovery results (2026-10-16)

Redacted results. Cloud account, resource IDs, IPs and private log paths are removed. Raw k6/app/bootstrap logs, Terraform state and console logs stay private.

## Integrity
- 45 parts downloaded from Drive and checked against SHA256SUMS.txt: all OK.
- Reassembled archive SHA256 = `471819e831451a133c1bba755ab493316ede087ab1132fe153011b0587cfc7d3` (matches). 1,073,155,999 bytes.
- Extracted, and `out/FILES-discovery-20261016.sha256` checked: all 29,788 files OK.
- Scorer: cwm-bench `main` @ ca0c0fb (PR #28 merged), `typical/dbsat-v1/score_dbsat_v1.py`. Error classes come from `request_outcomes_from_k6`, steady P95 from raw k6 samples, and achieved RPS from the raw k6 steady span. Records are in `records.json`, scorer output in `scores.json`.

## Per-apply table (steady window; overload steps = partial window)
| Cell | Rungs (complete) | Breach (criterion) | Achieved RPS at breach step | Steady P95 ms by rung | Err at breach (class) | DB CPU % at breach | AAS (io share) at breach | Max conns | Pool wait p95 / queued | App CPU max % | Recovery |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2x r1 (r1a) | 300 | 500, 16 min (errors) | 499.4 | 64.2 / 105.2 | 3.17% (500 internal) | 56.1 | 4.14 (0.70) | 392 | ~0 ms / 0 | 28 | failed (connections) |
| 2x r2 | 300, 500 | 700, 5 min (errors) | 699.9 | 61.6 / 111.5 / 133.2 | 7.80% (internal) | 62.1 | 3.05 (0.64) | 331 | ~0 / 0 | 35 | failed (connections) |
| 3x r1 (r1a, 7/6) | 300, 500, 700 | 900, 5 min (errors) | 899.4 | 34.4 / 94.5 / 180.6 / 444.1 | 15.0% (internal) | 96.6 | 35.8 (0.82) | 336 | ~0 / 0 | 33 | failed (connections) |
| 3x r2 (r2a rerun) | 300, 500 | 700, 8 min (errors) | 699.4 | 34.8 / 92.2 / 126.5 | 5.94% (internal) | 74.6 | 5.46 (0.69) | 424 | ~0 / 0 | 26 | failed (connections) |
| 4x r1 | 300, 500 | 700, 6 min (errors) | 700.0 | 17.5 / 71.5 / 127.8 | 5.12% (internal) | 72.1 | 5.72 (0.80) | 320 | ~0 / 0 | 20 | failed (connections) |
| 4x r2 | 300 | 500, 12 min (errors) | 499.5 | 31.8 / 83.9 | 2.13% (internal) | 55.6 | 1.77 (0.65) | 349 | ~0 / 0 | 15 | failed (connections) |

Every breach fired on the error-rate criterion (>5% for 3 consecutive minutes). P95 never came near 2,000 ms. The generator was valid on every step (CPU ≤14%, dropped iterations ≤0.09%, NetworkOut <0.3%). ALB ELB-5xx stayed ≤0.02% and there were no target connection errors. The lock wait share was 0 throughout and rds BurstBalance stayed at 99%. 502/unclassified points are ≤0.02% everywhere.
The complete step that carried errors was 3x r1 at 700: 1.93% internal. It had DB CPU 84.6% and AAS 8.6, which meets §6.2 cpu+io pressure.

## Transition scoring (prereg §6.1/§7.3, scorer output)
- 2→3: at 300 both pairs improve (P95 ratio 1.87 and 1.77). At 500 the step is not a both-complete comparison because 2x r1 breached; pair 2 gives ratio 1.21, below the ×1.45 threshold. 700 is not comparable. **Outcome: "No DB breakpoint established within tested range"** (the only complete step improves).
- 3→4: at 300 the result is **inconclusive**. Pair 1 gives P95 ratio 1.96 and improves. Pair 2 gives 1.09 and does not. This comes from 4x r2 at 300 having P95 31.8 ms against 17.5 ms in 4x r1. At 500 the step is not comparable because 4x r2 breached; pair 1 gives 1.32. **Outcome: "Inconclusive at 300"**.
- Neither transition is a candidate DB breakpoint, so **§7.4 confirmation is NOT triggered by the prereg**.

## Per-scale breakpoint
The prereg defines outcomes per transition, not a per-scale breakpoint, and it never pools reps. When reps disagree, §6.1 says paired disagreement means "inconclusive", and an overload step is never used as a comparison. Descriptively, using the highest step completed in both reps and the lowest breach across reps:
- 2x: complete in both through 300. Breach at 500 (r1) and 700 (r2).
- 3x: complete in both through 500. Breach at 900 (r1) and 700 (r2).
- 4x: complete in both through 300. Breach at 700 (r1) and 500 (r2).
Adding app servers does not move the breach point up. That gap between reps is as large as the gap between scales.

## Cause verdict: database side, not the app pool or app tier, but probably not plain saturation
- App pool ruled out. On every node and every minute, the pool wait p95 is under 0.1 ms (max ~2.5 ms), queued = 0, queueRejects = 0, and there are no queue_full errors. App CPU stays ≤35%. Connections peak at 424, below the 475 cap, and there are no too_many_connections or db_timeout errors.
- Errors are 100% `500/internal`: MySQL errors the app could not classify (server.js `classifyMysqlError` falls through). They are concentrated on GET /api/articles (2.8–11% of that endpoint) and POST /users/login.
- Onset is a **step function**, not a load ramp. Errors sit at 0.0% for minutes, then jump in one minute to 5–14% and stay there, while failing requests return quickly (P95 at the 4x r2 breach was 27–84 ms). In 4x r2 the breach came at 500 with DB CPU 55% and AAS 1.77, so no §6.2 pressure at all. The same 500 RPS completed with 0% errors in four other applies.
- DB pressure exists at the higher rungs (3x 900: CPU 97%, AAS 36). At several breaches, though (2x r1 500, 4x r2 500), the DB was moderate. The PI "io" share is 0.6–0.8 even at 300 RPS, where AAS is about 1. On MySQL that share is mostly table/handler I/O, not disk throttling (BurstBalance 99%).
- The global cause was confirmed in a later non-prereg diagnostic (see below): `max_prepared_stmt_count` was exhausted at the same minute that MySQL errno 1461 began. The per-statement cause (which queries or endpoints created the statements, for example variable-length IN lists) is **unverified**, because endpoint-level MySQL errno is unavailable.

## Recovery: harness/prereg artifact
All six "recovery failed" verdicts come from the connection rule alone. DB CPU fell to 3–4% and AAS to 0 within 1–2 minutes. Connections stayed flat at 320–424 because the app pools keep connections open, and the idle baseline at wait-ready was **0**. The "+20% / +20 of baseline" rule therefore cannot pass, no probe ever ran, and recovery failure was guaranteed by design. This does not invalidate the discovery steps (§7.2), but it would block any confirmation stack from being reused.

## Spend, deviations, hashes
- Cumulative spend-guard upper bound after the last apply (3x r2a): **$20.42 of $60**. This is a conservative stack-hours estimate, not the AWS bill.
- Replacement counter: 7 against a cap of 6.
- Deviations recorded in the archive:
  1. 3x r1: the workspace restarted during apply with 0 rungs run, and it was replaced once with owner approval (7/6). Recorded on 3x-r1a with controller `b842d703…` (1.1.10-admission).
  2. 3x r2: the app bootstrap seed race hit with 0 rungs run (READINESS_TIMEOUT). It was rerun with owner approval as an autonomy retry (ordinal 1, no replacement consumed). Recorded on 3x-r2a with controller `2cfebb18…` (1.1.11-admission; the same-hash condition was waived).
  3. Earlier: 2x r1 paused with 0 rungs; 2x r1a ran on controller `b43cbd15…`.
- Controllers by apply: 2x r1a `b43cbd15…`; 3x r1a, 4x r1, 4x r2 and 2x r2 `b842d703…`; 3x r2a `2cfebb18…`. Measurement SHA is `881e0cff…` throughout and RDS is 8.0.46-rds.20260908. All 9 attempts were cleaned up in both regions.

## Flags
1. The prereg does not trigger confirmation (no candidate in either transition). The plan to "continue into the confirmation applies" contradicts §7.4 unless it is disclosed as an extra.
2. Recovery failure is a structural artifact (idle-baseline connections = 0 against persistent pools).
3. AAS window-end null bug: it appears in the 2x r1a recovery polls (AAS average null while the datapoint is 0) and is fixed in later controllers. Steady-window PI series have no nulls in any step, so scoring is unaffected.
4. The adapter `errorCategories` label every error "unclassified" while k6 request_outcomes shows `500/internal`. PR #28's source is the correct one, and the adapter is stale.
5. A complete step shows `steadyMinutesObserved` 16 instead of 15 (minute flooring). This is harmless because the scorer uses the 900 s window.
6. The large spread between reps at low load (4x 300: P95 17.5 vs 31.8 ms) is what makes 3→4 inconclusive.
7. Mixed controller hashes inside the 6 cells are disclosed (above). These are admission-only changes; the measurement SHA is unchanged.

## Prereg verdicts
- 2→3: **No DB breakpoint established within the tested range.**
- 3→4: **Inconclusive at 300.**
- **Confirmation is not triggered (§7.4)**, because neither transition has a candidate breakpoint.

## Cause
- **App connection pool ruled out:** pool wait p95 stayed under 0.1 ms, with 0 queued, 0 queue rejects, no queue_full errors, and app CPU at 35% or lower.
- **The server-wide MySQL limit `max_prepared_stmt_count` (16,382) was exhausted.** In the diagnostic run below it went from 14,164 to 16,382/16,382 at 20:10 UTC, and errno 1461 deltas of 4,476 / 5,722 / 6,297 / 6,090 / 2,087 followed over 20:10–20:14. This matches the sudden-onset `500/internal` errors seen in discovery.
- **Per-statement and per-endpoint cause is unverified.** The app journal capture does not include endpoint-level MySQL errno, so we cannot say which queries filled the limit.

## Non-prereg 4x diagnostic (owner-approved; NOT discovery, NOT confirmation, NOT scored)
Files are in `diagnostic-4x-nonprereg/`. Measurement SHA is 881e0cf. Diagnostic controller manifest is `2200cbc1…7076`. The run used 4 app nodes and 1 generator, with rungs 300 / 500 / 700 starting at 18:58 / 19:28 / 20:05 UTC on 2026-10-16.
- The 700 rung breach was declared at 20:14:07 UTC, after the minutes 20:11–20:13 failed.
- **Two diagnostic-controller bugs, unfixed and disclosed:**
  1. A shadowed-variable breach hook (temporal dead zone).
  2. A missing aborted-rung gzip/exit.code path.
- Because of these bugs, the original 700 raw gzip and the breach-time InnoDB / top-errors snapshot were not secured. The 700 request_outcomes come from a separately labelled recovery-only gzip.
- The SQL snapshot taken at 20:34:51 UTC is **post-run, not breach-time**.
- Global MySQL counters are sampled every 15 s. They are not per-endpoint.
- Recovery ran no load. Cleanup passed in both regions (immediate and delayed).
- **Archive integrity:** the outer ZIP SHA256 as received is `b574fffaae242e0c8637e74f025a5d90fcf5a3b763c11d0310ee86ff88195851`, which is a macOS re-zip with `__MACOSX` entries. The runner-reported SHA256 is `968c26e965e3c059bfd41eb85ada296ee223607ab8d80eab58a6ca4f07cfbd28`. All 10 inner files verify against the inner `FILES.sha256`.

## Deviations (all disclosed)
- **7/6 replacement:** the 3x r1 workspace restarted during apply with 0 rungs run, and the run was replaced once with owner approval.
- **Seed-race rerun:** the 3x r2 app bootstrap seed race hit with 0 rungs run. The rerun was owner-approved and did not consume a replacement. The seed race itself is deferred to the next campaign version.
- **Runner autonomy addendum** dated 2026-10-16 (owner-approved).
- **Controller hashes:**
  - `b43cbd15…` (2x r1a)
  - `b842d703…` (1.1.10-admission: 3x r1a, 4x r1, 4x r2, 2x r2)
  - `2cfebb18…` (1.1.11-admission: 3x r2a; the same-hash condition was waived)
  - The measurement SHA 881e0cf is unchanged.
- **Recovery-rule artifact:** the idle baseline was 0 connections, but the app pools keep connections open, so recovery could never pass.
- **AAS window-end null bug:** appears in the 2x r1a recovery polls only. The steady-window PI data is unaffected.
- **Stale adapter labels:** the adapter's `errorCategories` say "unclassified". The k6 request_outcomes data says `500/internal` and is the source used here.
