# typical/dbsat-conn-2x-v1 — Results

**Verdict: NOT DECIDED.**

The prereg (r1.3, frozen at merge `c1978b9e`) needs two valid reps. Rep 1 is valid. All four rep 2 attempts (the original plus replacements r2a, r2b and r2c) are invalid. That uses up the 3 replacements allowed by §7.2, so the holdout closes not decided. No H1/H0 verdict is given, no scoring was done, and nothing was retuned. `PREREGISTRATION.md` is unchanged.

## Apply history

| Apply | Role | Rungs started | Outcome | Invalid reason |
|---|---|---|---|---|
| r1 (2026-10-19) | Rep 1 | 4 (300/500/700/900) | **Valid**. 300, 500 and 700 RPS completed and were collected. 900 RPS was an overload observation and recovery failed. | — |
| r2 (2026-10-19) | Rep 2, original | 2 (300 done, 500 interrupted) | Invalid, unscored | Pre-breach execution interruption: the controller workspace restarted during 500 RPS (cause not established) |
| r2a (2026-10-19) | Replacement 1/3 | 4 (300/500/700 done, 900 interrupted) | Invalid, unscored | Pre-breach execution interruption: the controller workspace restarted during 900 RPS, before collect |
| r2b (2026-10-20) | Replacement 2/3 | 1 (300 interrupted) | Invalid, unscored | Pre-breach execution interruption: the controller workspace restarted during 300 RPS, before collect |
| r2c (2026-10-20/21) | Replacement 3/3 | 0 | Invalid, unscored | Harness/infrastructure failure: an evidence-file collision (`EEXIST` on `bootstrap-readiness-ready-report.json`) at readiness, 18:53:05 UTC on 2026-10-21. No workload ran. |

For every apply, the immediate and delayed cleanup checks passed in both regions. r2c was destroyed at 18:55:44 UTC on 2026-10-21.

### r2c pre-workload attempts (same apply ID, 0 rungs each)

All of these failed before any workload ran and none changed measurement code or the workload. Retries 1–2 used the §7.1 allowance. Each later retry was a disclosed, owner-approved deviation beyond §7.1. None was a §7.2 replacement.

1. 2026-10-20 17:07 UTC: the deployment package left out a required campaign journal.
2. 2026-10-20 18:06 UTC: the runner role was missing a permission needed by the frozen Terraform's detailed monitoring.
3. 2026-10-20 19:08 UTC: an apply-started marker left by a prior attempt made the controller (correctly) refuse to replay.
4. 2026-10-20 20:48 UTC: evidence transport needed a missing storage package and a workspace-local service.
5. 2026-10-20 22:15 UTC: a write-once readiness destination collided with an earlier attempt.
6. 2026-10-21 17:51 UTC: a retry identity generated from the UTC date conflicted with the immutable original apply ID.
7. Final launch, 2026-10-21 18:53 UTC: a readiness evidence-file collision (`EEXIST`). This is the r2c row above.

## Rep 1 — descriptive only (not scored)

- 300, 500 and 700 RPS each completed with a complete collect and a valid generator.
- 900 RPS was stopped as an overload observation (about 8.5 minutes of load), and recovery failed. Across the sealed 900 RPS k6 run:
  - all outcomes: 166,668; failures: 34,229
  - 503 `queue_full`: 28,030; 500 `internal`: 3,263; 503 `too_many_connections`: 2,912; 502 unclassified: 24
  - `too_many_connections` was 8.5% of failures and 1.7% of all outcomes
  - dropped iterations: 2,554 of 945,000 scheduled (0.27%)
- These figures describe what one rep saw. With a single valid rep they don't support or reject H1. They are not compared against the frozen prediction here.

## r2a — descriptive only (invalid attempt)

r2a completed and collected 300, 500 and 700 RPS before the workspace restart at 900 RPS. Those three rungs are kept as descriptive evidence only. Because the attempt is invalid, they are not scored, not combined with rep 1, and not used as rep 2.

## Archive

- Private archive: `typical-dbsat-conn-2x-v1-20261019-not-decided.tar.gz`, 830,794,051 bytes, in 35 parts
- SHA256: `b4dcbed55a966933712d5a5f6b404d88f9943a9f73a3910046f9fbd41a24f33a`
- Location: the owner's private Google Drive folder `typical-dbsat-conn-2x-v1-not-decided-20261021`, which holds the 35 parts plus `MANIFEST.json`, `SHA256SUMS`, `README-download.txt`, `RUNNER-CLOSURE.json` and `CLOSURE-SHA256SUMS`. Access is private and on request.
- The runner reports that all 15 original k6 gzips and all 529 internal files verified. The invalid attempts are stored separately from rep 1. Private bootstrap/app/SQL logs, controller console output, credentials and Terraform state are excluded from the archive and retained privately.
- The runner instance was stopped, not terminated, at 19:48 UTC on 2026-10-21.

## Lessons learned

1. **Workspace restarts invalidated three rep 2 attempts.** Up to r2b, the benchmark controller ran inside a hosted development workspace. Restarts there (cause not established) killed the controller partway through load three times, at 500, 900 and 300 RPS. For long ladders, the controller must not run on a host that can restart underneath it.
2. **The move to an independent AWS runner.** r2c ran from a dedicated EC2 controller:
   - the controller ran under systemd with a narrow instance role;
   - storage was encrypted EBS plus a private S3 bucket;
   - a single-owner lock was in place;
   - recovery failed closed, so it never replays an apply or a rung.
   That design held: nothing was replayed and cleanup always passed.
3. **Hidden workspace dependencies.** Porting to the runner exposed things the old setup supplied without being declared:
   - a journal that was not packaged;
   - a missing IAM permission;
   - a workspace-local storage client and service;
   - evidence paths and markers scoped to the apply ID instead of the attempt;
   - an identity that depended on the date.
   Each one failed safely before load, but together they used up the campaign. Future campaigns should run a full no-load rehearsal on the target runner *with retained state from prior attempts*, so collisions in write-once destinations show up. Launch and cleanup status reporting should also be made accurate.
4. Valid rep 1 evidence on its own does not settle the 2× question. A future 2× holdout needs a new prereg.
