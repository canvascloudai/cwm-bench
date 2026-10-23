# typical/dbsat-cpu-2x-r5xl-v1 — Results

**Verdict: H0.** Both valid reps had a qualifying breach at **1500 RPS** on the error criterion: 9.1 / 9.4 / 11.5% (rep 1) and 16.7 / 17.4 / 17.3% (rep 2) across the three breach minutes. P95 stayed below 2,000 ms, at about 950–1,090 ms. The frozen nominal prediction (§5.2) was **no qualifying breach from 300 to 1500**, so it fails. 300–1300 completed with no breach in both reps. At the breach rung, `503/queue_full` was dominant (81.6% / 79.9% of failures). Under the mechanism reading fixed in advance in §5.4, this means DB CPU / service capacity did not scale as assumed.

This is scored strictly against `PREREGISTRATION.md` on `main` (freeze merge `9a8d720c`) and the nominal §5.2 prediction only. No sensitivity variant was selected, and nothing was tuned after the results were seen.

## Provenance (verified)
- **Archive.** `typical-dbsat-cpu-2x-r5xl-v1-20261023.tar.gz` is stored as 71 parts in the owner's private Drive.
  - Every part matches `SHA256SUMS`.
  - The reassembled SHA256 is `322dbe35ef1c2fc970be5fcc2edc93961a91a94568f41f0a9e17ae0113d66748`, recomputed and matching.
  - Every entry in the archive's internal `FILES.sha256` verified.
- **Freeze receipt.**
  - Wiring commit `9a8d720c` is the merge of the §8.3 freeze.
  - App/load diff against measurement basis `881e0cff` is empty, recomputed here.
  - The archived `PREREGISTRATION.md` is byte-identical to the file on `main` (`d1933401…a660`).
  - Manifest `b1d51ace…cde1` is the manifest's recorded `sha256`. Its derivation was not reproduced here; 119 of 136 listed file hashes were checked against the exported sources with 0 mismatches, and the other 17 are private and not exported.
  - Controller `fed63760…06ef` was recomputed from the deployed controller file.
- **Hardware (E1).** For both reps, AWS-reported `DBInstanceClass` = `db.r5.xlarge`, with 4 vCPU from the paired DescribeInstanceTypes. Wait-ready `max_prepared_stmt_count` / `max_connections` = 65528 / 500.
- **Ladder.** 300 / 500 / 700 / 900 / 1100 / 1300 / 1500 RPS, with 300 s warmup and 900 s steady, on 2× m5.large app nodes. There were no rung retries.
- **Rep IDs (disclosed).**
  - `typical-dbsat-pscap-2x-r1a-20261022` and `typical-dbsat-pscap-2x-r2-20261023` are the campaign's **initial** reps, recorded as `initialRep: true, replacement: false`.
  - 0 replacements were consumed.
  - The `r1a` suffix avoids collisions with IDs from v1/v1.1, and `r1c` was taken by the no-load rehearsal.
  - The reps ran on different UTC days.

## Validity (§5.5): both reps valid

| Check | Rep 1 (`…-r1a-20261022`) | Rep 2 (`…-r2-20261023`) |
|---|---|---|
| E1 class / vCPU / `max_prepared_stmt_count` / `max_connections` | db.r5.xlarge / 4 / 65528 / 500 | db.r5.xlarge / 4 / 65528 / 500 |
| E2 breach-monitor rows, every rung through the declaration | yes | yes |
| E3 raw k6 gzips match download verification | yes (runner gate; 16 original gzips verified in packaging) | yes |
| E4 15 s polls missing, breach rung / first rung → decl + 60 s | 0 of 38 / 0 of 957 | 0 of 38 / 0 of 893 |
| E5-pre strict dropped ratio 300…1300 (≤ 0.005) | max 0.00105 (1300) | max 0.00134 (1300) |
| E5-pre generator CPU steady mean (≤ 70%) | 6.1 … 21.8% | 6.9 … 23.1% |
| E5-breach: CPU minutes ≤ 70%, none missing | yes (max 25.3%) | yes |
| E5-breach: stop marker, k6 exit, only the interrupt `level=error` line | yes, exit 105 | yes, exit 105 |
| Harness failure before the declaration | none | none |
| Breach-rung strict dropped ratio (descriptive) | 0.0049 | 0.0067 |

- The post-breach `recovery failed` at 1500 in both reps happened after the declaration. Under §7.2a, recovery after load is cleanup only, so it does not affect validity.
- **Cleanup.** Immediate and ≥ 15-minute delayed checks passed in us-east-2 and us-west-2 after each rep, with `liveCleanupConfirmed` true. `strictTagInventoryEmpty` was false (inventory showed terminated or not-found items only).
- The rep 1 900 rung has two extra collect attempts, retained. The canonical collect is complete, and the load was not repeated.
- A first results export failed on a Python `pathlib` incompatibility and was retained. The re-export used byte-identical hard links, with no apply or rung repeated.

## Scoring (§3.1, §5.4)
The breach was recomputed independently from the raw k6 gzips (`recompute_breach_minutes.py`). It agrees with the runner's breach monitor on the rung and the three minutes in both reps.

| RPS | Rep 1 err % | Rep 1 P95 ms | Rep 1 DB CPU mean / peak % | Rep 2 err % | Rep 2 P95 ms | Rep 2 DB CPU mean / peak % | §5.2 err % / P95 / DB CPU |
|---:|---:|---:|---:|---:|---:|---:|---|
| 300 | 0.003 | 12 | 13.4 / 14.9 | 0.004 | 17 | 14.4 / 15.7 | 0.107 / 30 / 15.2 |
| 500 | 0.011 | 80 | 22.3 / 22.9 | 0.017 | 63 | 23.8 / 25.4 | 0.107 / 38 / 25.3 |
| 700 | 0.023 | 109 | 33.6 / 34.5 | 0.010 | 110 | 35.9 / 37.1 | 0.107 / 49 / 35.4 |
| 900 | 0.021 | 171 | 47.3 / 48.7 | 0.018 | 177 | 49.8 / 51.2 | 0.181 / 68 / 45.5 |
| 1100 | 0.040 | 310 | 61.6 / 65.9 | 0.032 | 335 | 67.1 / 74.1 | 0.181 / 100 / 55.6 |
| 1300 | 0.80 | 678 | 81.1 / 87.9 | 3.51 | 887 | 92.6 / 97.0 | 0.181 / 163 / 65.8 |
| **1500** | **10.10 (breach)** | 956 | 93.7 / 95.6 | **17.14 (breach)** | 1,078 | 96.0 / 96.7 | 0.181 / 317 / 75.9 |

- How the columns are computed:
  - Error % and P95 are over all phase=steady points. P95 is nearest-rank.
  - DB CPU is CloudWatch 1-minute `CPUUtilization` over the steady window.
  - At 1500 the steady window ran only up to the breach stop: 3 full minutes plus partial minutes.
- **Breach minutes (UTC):**
  - Rep 1: 00:44, 00:45, 00:46, declared at 00:47:04.
  - Rep 2: 06:34, 06:35, 06:36, declared at 06:37:06.
- **Near-miss at 1300 (rep 2).** One eligible minute reached 5.52% error. The streak never reached 2, so this is not a breach.

**Failure classes, share of steady failures (descriptive):**

| RPS | Rep 1 queue_full / TMC / internal / other | Rep 2 queue_full / TMC / internal / other |
|---:|---|---|
| 300–900 | 0 / 0 / 0 / 100% (a few 502) | 0 / 0 / 0 / 100% |
| 1100 | 6.2 / 2.2 / 1.8 / 89.7% | 18.1 / 6.7 / 0.6 / 74.6% |
| 1300 | 62.3 / 21.1 / 8.5 / 8.0% | 63.8 / 25.9 / 8.8 / 1.5% |
| 1500 | **81.6** / 8.0 / 9.8 / 0.6% | **79.9** / 10.4 / 9.4 / 0.3% |

| | Predicted (§5.2) | Rep 1 | Rep 2 |
|---|---|---|---|
| First breach rung B | none on 300–1500 | **1500** | **1500** |
| Criterion | — | error (P95 < 2,000) | error (P95 < 2,000) |
| Dominant class at B | (`queue_full` 0%) | `queue_full` 81.6% | `queue_full` 79.9% |
| Max `Threads_connected` (whole apply) | 503 | 503 | 503 |
| Pool-wait P95 at 1500 | 0 | 78.7 ms | 123.7 ms |
| **Per-rep verdict** | | **H0** | **H0** |

**Campaign: H0** (both valid reps are H0).

## Interpretation (mechanism reading fixed in advance; not scored)
- **`queue_full` dominant at 1500.** Per §5.4 this means DB CPU / service capacity did not scale as assumed by the CPU multiplier of 2.
- **DB CPU ran ahead of the prediction.** It was 81–93% at 1300 against 65.8% predicted, and about 94–96% at 1500 against 75.9%. The 2× CPU transfer is too optimistic at high load. At 300–900 it was close, within about ±2–4 pp.
- **Capacity-1.5 sensitivity (§5.3).** This variant was disclosed before any apply and is **not scored**. It recorded a first breach at 1500 with `queue_full` dominant, which matches the observed rung and class; its magnitudes at 1500 (99.9% error, extreme P95) are far worse than observed. This does not change H0 and is not a post-hoc model selection.
- **Connection ceiling.** The ceiling bound from about 1100, as predicted (from 900). `too_many_connections` reached 8–26% of failures at 1100–1500, against ≈ 0.07% of all responses predicted.

## Files
`results/holdout-20261023/`:
- `build_records.py` and `build_rung_tables.py`: the conn-2x-v1.1 scripts, unchanged apart from docstrings. They use the unchanged `score_dbsat_v1` scorer.
- `recompute_breach_minutes.py`: an independent §3.1 recompute from raw k6.
- `evaluate_cpu_r5xl_v1.py`: the §5.4/§5.5 lookup.
- `gate.json`: an excerpt of the runner's E1–E5 evidence gate, redacted.
- `records.json`, `rung-tables.json`, `breach-minutes.json`, `verdict.json`.

To reproduce, run from this directory: `python3 build_records.py EVIDENCE --repo ../../../..`, `python3 build_rung_tables.py EVIDENCE`, `python3 recompute_breach_minutes.py EVIDENCE`, then `python3 evaluate_cpu_r5xl_v1.py`.

The raw archive is private. AWS account IDs, ARNs, instance/volume/resource IDs (including directory names), IPs, endpoints and runner paths are redacted from everything published here.
