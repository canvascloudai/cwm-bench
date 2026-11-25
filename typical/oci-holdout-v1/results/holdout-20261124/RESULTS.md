# oci-holdout-v1 results (r1 2026-11-22 ET, r2 2026-11-23 ET): holdout NOT verified for either prediction set

These are the official scores for the oci-holdout-v1 campaign preregistered in `../../PREREGISTRATION.md`. Two fresh applies (r1, r2) in `us-ashburn-1` AD-1 each ran the full 10 → 100 → 500 → 1000 RPS ladder (300 s ramp + 900 s steady per rung). Every scored rung finished with **zero total request loss and zero hard errors** in its steady window.

- Measurement pin: `17376407cd8107732f35ba45785a9a06e10849a3` (merge of PR #71, adapter **1.9.6**). `PREREGISTRATION.md`, `freeze/`, load scripts, Terraform and the scoring rule were not edited.
- Redacted campaign archive: 16 parts (`ARCHIVE-PARTS.sha256`). Concatenated in filename order, its SHA-256 is `9988448848533153ea41cf7a245fd8b639a4c7b60668175bf8d0371c10b29f4e`.
- Frozen predictions: Set A is the published `/accuracy` OCI cell. Set B is live engine 1.2.77 (revision `fb400b40135f`). Both come from `../../freeze/predictions.json` and are scored separately. They are never combined.

## Verdict

**OCI accuracy is not verified for Set A or Set B.** No rung of either rep reaches the 95 floor in either set (0/8 and 0/8). Cost is `null` for every rung, so every composite is reported **without cost**, with the other five weights renormalized by 1/0.9.

- **Set A (published `/accuracy` OCI cell): fails on every rung.** Composites are 14.7–17.7. The cell predicts P95 of 46–297 ms, app CPU of 4.3–82.6% and errors of 0.11–11.7%. The stack measured a P95 of 4.0–6.0 ms, app CPU of 0.2–4.8% and 0% loss. Every rung is in the P95 `fail` band, at 661–7240% off.
- **Set B (live engine): fails the composite on every rung, but its P95 is close.** Composites are 43.0–79.2. P95 is in the `pass` band on 6 of 8 rungs. The two exceptions are r2 500 and r2 1000, which are `marginal` at 21.9% and 23.6%. All four cross-rep means pass the band. The composite fails because P50 is predicted at 5 ms against a measured 2.2–3.2 ms (scores 0–44), app CPU is off at 10 RPS and 1000 RPS, and 0.206% and 0.824% loss are predicted at 500 RPS and 1000 RPS against 0% measured (error scores 4.9 and 1.2).
- No rung is `saturated`, because steady loss was 0% everywhere.

**The published OCI `/accuracy` cell (Set A) should be replaced by the measured results in this directory.** It is a documentation-reference comparison, and it is far from a measured OCI stack on latency, CPU and errors. If anything is calibrated on r1/r2, those reps become **fit data**. A new OCI holdout (new directory, new pin, new frozen predictions) is then required before any OCI accuracy claim. Results from different pins are never pooled.

## Measured values (steady window, recomputed from raw evidence)

| rep | RPS | P50 ms | P95 ms | P99 ms | throughput RPS | total loss % | hard errors % | app CPU % (node 0 / node 1 / mean) | DB CPU % | DB conns avg / max | cost $/hr |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|
| r1 | 10 | 3.154 | 5.588 | 6.705 | 10.000 | 0.00 | 0.00 | 1.47 / 0.21 / 0.84 | 26.17 | 5.0 / 5 | null |
| r1 | 100 | 2.484 | 4.836 | 6.015 | 99.993 | 0.00 | 0.00 | 0.74 / 1.35 / 1.05 | 28.74 | 6.6 / 7 | null |
| r1 | 500 | 2.274 | 4.510 | 6.574 | 499.892 | 0.00 | 0.00 | 3.56 / 4.03 / 3.79 | 32.70 | 14.3 / 15 | null |
| r1 | 1000 | 2.252 | 4.565 | 7.940 | 999.571 | 0.00 | 0.00 | 4.83 / 4.72 / 4.77 | 39.45 | 29.5 / 33 | null |
| r2 | 10 | 3.200 | 6.043 | 12.058 | 10.000 | 0.00 | 0.00 | 0.23 / 0.24 / 0.23 | 29.44 | 5.0 / 5 | null |
| r2 | 100 | 2.396 | 4.345 | 5.535 | 99.993 | 0.00 | 0.00 | 2.81 / 0.76 / 1.78 | 28.89 | 10.1 / 14 | null |
| r2 | 500 | 2.276 | 4.102 | 6.202 | 499.879 | 0.00 | 0.00 | 3.71 / 5.80 / 4.75 | 34.08 | 16.9 / 17 | null |
| r2 | 1000 | 2.228 | 4.046 | 6.946 | 999.543 | 0.00 | 0.00 | 4.49 / 5.11 / 4.80 | 38.27 | 24.5 / 27 | null |

These were measured as follows:

- **Latency:** nearest-rank `ceil(p·N)−1` over raw k6 `http_req_duration` points that are tagged `phase=steady` and fall within `[start+300 s, start+1200 s)` of each rung's completion marker.
- **Throughput:** steady completions divided by 900 s.
- **Loss:** non-2xx responses plus dropped iterations, as a share of requests plus dropped iterations.
- **CPU and DB connections:** OCI Monitoring 1-minute series saved in `collect-<rps>.json`, steady window, using the pinned `oci-evidence.mjs` rule (`t ≥ start` and `t + 60 s ≤ end`, which gives 14 points per metric).

The steady windows contain 9,000, 89,994, 449,903 / 449,891 and 899,614 / 899,589 requests (r1 / r2 where they differ). The only HTTP statuses are 200 and 201. There are no dropped iterations.

`recompute.py` reproduces every runner-reported value exactly, with 0 mismatches at 1e-6 (P50, P95, P99, throughput, loss, hard errors, app CPU, DB CPU and DB connections). The pinned parser (`scripts/lib/adapter/oci-raw.py`, SHA-256 `a6e0c472…5b11`) also reproduces them when run directly on the archive.

## Set A — published `/accuracy` OCI cell

| rep | RPS | P50 | P95 | CPU | throughput | error | composite (no cost) | rung | P95 err | P95 band |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| r1 | 10 | 0.0 | 0.0 | 0.0 | 99.9 | 9.1 | **17.66** | fail | 723.2% | fail |
| r1 | 100 | 0.0 | 0.0 | 0.0 | 99.7 | 3.4 | **17.00** | fail | 1285.4% | fail |
| r1 | 500 | 0.0 | 0.0 | 0.0 | 97.4 | 0.4 | **16.27** | fail | 3492.0% | fail |
| r1 | 1000 | 0.0 | 0.0 | 0.0 | 88.3 | 0.1 | **14.73** | fail | 6406.1% | fail |
| r2 | 10 | 0.0 | 0.0 | 0.0 | 99.9 | 9.1 | **17.66** | fail | 661.3% | fail |
| r2 | 100 | 0.0 | 0.0 | 0.0 | 99.7 | 3.4 | **17.00** | fail | 1441.9% | fail |
| r2 | 500 | 0.0 | 0.0 | 0.0 | 97.4 | 0.4 | **16.27** | fail | 3849.2% | fail |
| r2 | 1000 | 0.0 | 0.0 | 0.0 | 88.3 | 0.1 | **14.73** | fail | 7239.9% | fail |

The cross-rep means (both reps were healthy on every rung) score composites of 17.66, 17.00, 16.27 and 14.73. Their P95 bands all `fail`, at 691%, 1360%, 3662% and 6798%. The cell publishes no P99, DB CPU or DB connections, so those are not scored for Set A.

## Set B — live engine 1.2.77

| rep | RPS | P50 | P95 | CPU | throughput | error | composite (no cost) | rung | P95 err | P95 band |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| r1 | 10 | 41.5 | 89.5 | 23.2 | 100.0 | 100.0 | **67.01** | fail | 10.5% | pass |
| r1 | 100 | 0.0 | 96.6 | 90.9 | 100.0 | 100.0 | **74.81** | fail | 3.4% | pass |
| r1 | 500 | 0.0 | 89.1 | 86.4 | 99.8 | 4.9 | **61.14** | fail | 10.9% | pass |
| r1 | 1000 | 0.0 | 90.5 | 22.0 | 99.2 | 1.2 | **46.69** | fail | 9.5% | pass |
| r2 | 10 | 43.7 | 82.7 | 84.4 | 100.0 | 100.0 | **79.23** | fail | 17.3% | pass |
| r2 | 100 | 0.0 | 84.9 | 53.3 | 100.0 | 100.0 | **63.21** | fail | 15.1% | pass |
| r2 | 500 | 0.0 | 78.1 | 90.6 | 99.8 | 4.9 | **59.00** | fail | 21.9% | marginal |
| r2 | 1000 | 0.0 | 76.4 | 23.1 | 99.2 | 1.2 | **43.03** | fail | 23.6% | marginal |

The cross-rep means score composites of 69.23, 68.00, 62.53 and 44.98. Their P95 bands all `pass`, at 14.0%, 8.9%, 16.1% and 16.1%.

The Set B P95 is a flat 5 ms, which the engine labels a generic internal-LB baseline with load scope not calibrated. The P95 agreement here is therefore an observation, not evidence of a calibrated OCI latency model.

### Set B extras (reported, not in the composite)

| rep | RPS | P99 ms pred / meas (rel) | DB CPU % pred / meas (rel) | DB conns pred / meas avg (rel) | hard errors % pred / meas (rel) |
|---|---:|---|---|---|---|
| r1 | 10 | 140 / 6.705 (0.0) | 1 / 26.17 (3.8) | 2 / 5.0 (40.0) | 0 / 0.00 (100.0) |
| r1 | 100 | 237 / 6.015 (0.0) | 1 / 28.74 (3.5) | 20 / 6.6 (0.0) | 0 / 0.00 (100.0) |
| r1 | 500 | 773 / 6.574 (0.0) | 5.4 / 32.70 (16.5) | 100 / 14.3 (0.0) | 0 / 0.00 (100.0) |
| r1 | 1000 | 1686 / 7.940 (0.0) | 14.3 / 39.45 (36.3) | 200 / 29.5 (0.0) | 0 / 0.00 (100.0) |
| r2 | 10 | 140 / 12.058 (0.0) | 1 / 29.44 (3.4) | 2 / 5.0 (40.0) | 0 / 0.00 (100.0) |
| r2 | 100 | 237 / 5.535 (0.0) | 1 / 28.89 (3.5) | 20 / 10.1 (1.4) | 0 / 0.00 (100.0) |
| r2 | 500 | 773 / 6.202 (0.0) | 5.4 / 34.08 (15.8) | 100 / 16.9 (0.0) | 0 / 0.00 (100.0) |
| r2 | 1000 | 1686 / 6.946 (0.0) | 14.3 / 38.27 (37.4) | 200 / 24.5 (0.0) | 0 / 0.00 (100.0) |

The extras show where Set B is off:

- **P99:** predicted 140–1686 ms against 5.5–12.1 ms measured.
- **DB CPU:** under-predicted. The measured idle floor is about 26–29% even at 10 RPS.
- **DB connections:** over-predicted from 100 RPS up.
- **Hard errors:** 0 predicted and 0 measured.

## Scoring rule as applied

The rule is the one in `PREREGISTRATION.md` → "Composite", with `rel`/`errs` exactly as in `typical/score.py`:

- `rel = max(0, 100 − |sim − ref| / |ref| × 100)`.
- Error scores 100 if within 0.01 pp, otherwise `max(100 × 0.01 / |sim − ref|, rel)`.
- Weights: P50 .20, P95 .25, CPU .20, throughput .15, error .10, cost .10.
- With cost null, the composite is the sum of the first five weighted scores divided by 0.9.
- A rung passes at ≥ 95. A set is verified only if every rung of both reps passes.
- P95 bands on `|pred − meas| / meas`: pass ≤ 20%, marginal ≤ 35%, fail > 35%.

The prereg text is silent on a measured value of 0. The rule follows the cited `typical/score.py` conventions:

- **Error with ref 0:** the `rel` part is taken as 0. Every measured loss is 0, so the error score is 100 only when the prediction is within 0.01 pp, and otherwise `1 / |pred|`.
- **`rel(sim, 0)` is 100:** this affects only the Set B hard-error extra, where pred = meas = 0.

Neither convention can change a verdict. Even with a perfect error score, no composite would reach 95 in either set.

## Evidence checks

| check | result |
|---|---|
| 16 part SHA-256s vs `ARCHIVE-PARTS.sha256` | pass (16/16) |
| Combined archive SHA-256 | pass (`99884488…9f4e`) |
| `DERIVATIVES.json`: every file hash vs the archive | pass (105/105). The two files not listed are `SUMMARY.json` and `DERIVATIVES.json` |
| Original raw SHAs (k6, summary, complete) vs per-rung `archive.json` (status `VERIFIED`), `SUMMARY.json` and `collect-*.json` | pass. The 9 k6 files in the archive are privacy-only derivatives; collection hashes describe the originals |
| Recompute vs runner summary (all 8 scored rungs) | pass, 0 mismatches |
| Pin `17376407…49a3` on `main`, adapter 1.9.6; every run marker's `measurementSha` | pass |
| Pinned source files in the controller manifests (`oci-raw.py`, `oci-catalog.mjs`, `oci-host-identity.mjs`, `oci-pin-ssh-hosts.mjs`) byte-identical to the pin | pass |
| Versions: k6 v0.54.0, Node v20.20.2, MySQL 8.4.13-cloud, `max_connections` 1000 by applied SQL readback, 2 backends | pass (within major/minor pins) |
| Ladder, 300 s + 900 s per rung, exit code 0, steady window bounds | pass |
| r2 ≥ 12 h after r1, on a different ET day and UTC day | pass. r1 destroy 2026-11-22 9:07 PM ET → r2 apply 2026-11-23 7:02 PM ET (21 h 55 m). ET days Nov 22 / Nov 23. UTC days Nov 23 / Nov 24 |
| Per-apply duration ≤ 3 h; total ≤ 6 resource-hours | pass. About 2 h 05 m per scored apply; 5.73 h total, runner-reported across all applies |
| Replacements ≤ 3 per rep | pass. r1 used 2 replacements (runner faults, below); r2 used 0 |
| Immediate cleanup (destroy, sweep) | pass with retry, for all 4 applies. Destroy OK and Terraform state empty. The first sweep still listed 9–10 owned entries (VCN, subnet, DNS, MySQL configuration/DB system deleting, terminated instances). The 2-hour destroy-only retry found 0 owned resources and only 3 terminated instances listed |
| 24-hour inventory sweep and MySQL backups | pass, for all 4 applies. 0 owned resources, 0 backups |
| 24-hour Cost Analysis check that charges stopped | **not verified.** Billing coverage was unavailable (`stoppedCharges.verified: false`) |
| Spend | about $3.39 reported by the runner, below the prereg's $25 soft cap. The runner's admission caps were raised to $40, $60 and then $100 in pause-to-ask steps. It paused at the cap twice and never auto-stopped |
| Privacy scan (`redaction_scan.sh`) over the whole extracted archive, gzip payloads included, and over this directory | pass. No `ocid1.`, PEM `BEGIN` blocks, SSH keys, fingerprints, IPv4 addresses, Terraform state, plans, user_data or known_hosts. Resource IDs appear only as `[REDACTED_OCI_ID]` |

### Controllers (runner-side, outside cwm-bench)

| controller SHA-256 | role |
|---|---|
| `fea4980e…7733` | r1 plan only; paused at spend cap, no apply |
| `ce9cdb80…a0b` | r1 attempt `ad1b-20261122`: runner fault `RUNG_ARCHIVE_REMOTE_HASH_FAILED` during rung 10 (control-connection fault). Invalid, whole apply replaced |
| `349ff7d9…1e4d` | r1 plan only; paused at spend cap, no apply |
| `450aa3d6c4a41e3a9acdb41cc746477d120445150900019fb860d1040771ad48` | r1 attempt `ad1c-20261122`: runner-side controller fault (`ran is not defined`) after rung 10. Invalid, whole apply replaced, nothing pooled |
| `03e2657e6c8ee25ed95623406239fd4b7fbd88c4fa98cc5585514c50a0ddb415` | **r1 measurement** (`oci-holdout-v1-r1-ad1-20261123`) |
| `f78e5fa5aa2dde0cfe307659ad2ec7cc577669032ba7d46cb6c715fb31ef76ab` | r1 cleanup resume (launcher-only, 74 tests) and **r2 measurement** (`oci-holdout-v1-r2-ad1-20261124`) |
| `ab21457b199c9faad76940ca00a9a9b9b9f221dfa3c15dc9d7bd6771dcb4abe8` | r2 cleanup-only resume; cannot apply or dispatch a rung |
| `ece81a9e415f07fd60f8d0a7d48af6e47b15a02d9e37a35a36e40922ff14a5cb` | approved controller baseline named in both provenance records |

The two faults were different, so the two-identical-deterministic-errors guard did not trip.

The `ab21457b` manifest differs from `f78e5fa5` only in `campaign.ts`, `launch.sh` and `restart-state(.test).mjs`. The parser, pinned source files, rules, finalization and k6 setup are unchanged.

Earlier preflight-only controllers (`06baab94`, `38cd1b64`, `ebbd015b`) do not appear in this archive, and no apply event here names them.

## Notes

1. Cost is `null` for every rung: no OCI cost report covered the run windows. It is never zero and never estimated. All composites are labeled without cost.
2. `../../PIN.md` still names `783896c3` (adapter 1.9.4). The executed pin is `17376407` (adapter 1.9.6), recorded in the archive as owner-approved without a PIN.md follow-up. This PR does not edit PIN.md or the prereg.
3. The r1 apply id carries its UTC date (`20261123`). It ran on the evening of 2026-11-22 ET.
4. r1 at 10 RPS showed uneven app-node CPU (1.47% vs 0.21%). At these utilizations this is noise and does not affect any verdict.

## Reproduce

```bash
# from the extracted archive root, with predictions from the pin
python3 recompute.py score . <cwm-bench>/typical/oci-holdout-v1/freeze/predictions.json out/
python3 recompute.py raw attempts/oci-holdout-v1-r2-ad1-20261124 1000   # one rung -> JSON
./redaction_scan.sh .
```

Files in this directory:

- `measured.json` / `measured.csv`: recomputed measurements.
- `scores.json` / `scores.csv`: per-metric scores, composites, bands, extras and cross-rep means for both sets.
- `evidence.json`: hashes, controllers, timeline and cleanup.
- `ARCHIVE-PARTS.sha256`: archive part checksums.
