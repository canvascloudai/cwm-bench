# Campaign export summary `typical-holdouts-v1-20261006`

Day and region holdouts for the fitted `typical-v1-20260927c` reference. Not a new fit, and not an update to `calibrate/coefficients.yaml` or the calibration id.

| Field | Value |
| --- | --- |
| campaignId | `typical-holdouts-v1-20261006` |
| applies | `typical-later-day-20261006` (us-east-2), `typical-second-region-20261006` (us-west-2) |
| measurement commit | `64c6e89d74e25c549e7dad740471443621da5aac` |
| adapterVersion | 1.4.0 |
| scored against | frozen after-fit reference at that commit; engine 1.2.5; calibration id unchanged |
| fit date checked on the east apply | `CWM_FIT_CAMPAIGN_DATE=2026-09-27` (unset on the west apply) |
| topology | 2 x m5.large, db.r5.large MySQL 8.0, internal ALB, c6i.xlarge generator |
| pool | 250 per server, 2 workers, `max_connections` 500 |
| attempts | 1 per key. East 100 was recovered after a workspace restart, not rerun. Two earlier east preparations stopped before apply |
| complete / knownGap / invented | true / false / false on every collect; `missing` [] |
| identity / k6 counters | `identityMatches` true; `counterConsistency.valid` true |
| cost | null (not measured) |
| east apply start / finish (UTC) | 2026-10-06T02:21:08.680Z / 2026-10-06T02:28:10.556Z |
| east destroy (`93-destroy-finished-1791256294855.json`) | 2026-10-06T03:14:22.480Z |
| west apply start / finish (UTC) | 2026-10-06T03:15:25.451Z / 2026-10-06T03:22:31.973Z |
| west destroy (`93-destroy-finished-1791259573879.json`) | 2026-10-06T04:10:51.556Z |
| resolved AMI | east `ami-0d3d85815a9746bc5`; west `ami-0d53cc9bd365ad65b` (typical-v1 was `ami-08be4b1b8afa29958`) |
| east app nodes | `i-0e1228d035f8eeff8`, `i-0f8e186eb5ff6aab2` (profile typical, workers 2, git SHA above); generator `i-019f83709efdd11ac` |
| west app nodes | `i-00765ba981e3ce573`, `i-02362b5e3d0880004` (profile typical, workers 2, git SHA above); generator `i-01e5f143a23b5ae3f` |

Collect JSON, with the AWS account id replaced by `REDACTED`, is in `typical/campaign/typical-holdouts-v1-20261006/`. The east collects are under `preparation-attempt3/typical-later-day-20261006/`. The west collects are under `typical-second-region-20261006/`. Scores are in `typical/scores-holdouts-v1-20261006.json`. Per-rung metrics, deltas, and scores are in `holdout/exports/typical-holdouts-v1-20261006.metrics.csv`. The write-up is the last section of `typical/REPORT.md`.

## Runs

App CPU is the mean of the two hosts. Goodput, latency, and error rate are from the collect document. Error count is k6 failed requests over `http_reqs`. Generator CPU peak is the steady-window 1-minute peak.

| scenario | region | target | goodput | p50 | p95 | p99 | app CPU | db CPU | db conn max | failed / requests | generator CPU peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| typical-later-day | us-east-2 | 100 | 87.6253492297855 | 5.439607 | 9.7898165 | 88.75636449999999 | 5.461536845099605 | 13.473813450609272 | 25 | 0 / 105151 | 2 |
| typical-later-day-300 | us-east-2 | 300 | 262.55196121325883 | 5.175492 | 51.122386600000034 | 126.41098951999969 | 15.813503285780286 | 31.418488497715792 | 428 | 21 / 315097 | 4.986666666666666 |
| typical-second-region | us-west-2 | 100 | 87.6215288088677 | 4.531484 | 7.629682399999997 | 88.17071732000001 | 5.72531975451282 | 12.614102564102563 | 22 | 3 / 105149 | 2.1 |
| typical-second-region-300 | us-west-2 | 300 | 262.6124176163182 | 4.621589 | 32.88688839999976 | 112.82016088000026 | 16.085248562592426 | 29.269852842091094 | 348 | 12 / 315149 | 5.011666666666667 |

Steady windows (UTC): east 100 `2026-10-06T02:34:21Z–02:49:21Z`; east 300 `02:55:36Z–03:10:36Z`; west 100 `03:28:56Z–03:43:56Z`; west 300 `03:50:23Z–04:05:23Z`.

Generator CPU steady average / peak: 1.8983334053953083 / 2, 4.821014048639058 / 4.986666666666666, 2.0098615647845697 / 2.1, 4.910641025641025 / 5.011666666666667. All are under the 70% discard line.

Scheduled iteration counts from the typical-v1 rung of the same rate are 105,151 at 100 RPS and 315,149 at 300 RPS. East 300 finished 315,097 iterations (52 short). Its steady VU cap in the run log grew from 400 to 423. West 100 finished 105,149 (2 short). The other two rungs matched the scheduled count. Every failure was unclassified. Nothing was dropped from the score.

ALB steady-window request rate (request count summary divided by 780 seconds): 100.0, 299.9320512820513, 100.0, 299.9935897435897.

ALB latency p50 / p95 / p99:

| scenario | p50 | p95 | p99 | ALB 5xx sum | target 5xx |
| --- | ---: | ---: | ---: | ---: | --- |
| typical-later-day | 4.350831205089983 | 7.528422376462726 | 83.83535008655593 | none (no datapoints) | unmeasured |
| typical-later-day-300 | 4.406770594746318 | 69.9910124983373 | 249.0308646568233 | 17 | unmeasured |
| typical-second-region | 3.8674717001602574 | 7.138084837137048 | 81.88590660270687 | 3 | unmeasured |
| typical-second-region-300 | 3.8811730032440246 | 37.89151213559106 | 198.93500887303276 | 1 | unmeasured |

RDS BurstBalance minimum was 99 on every rung. App-volume BurstBalance minimum was 99, except west 300 volume `vol-0d4b18ac4d1e544c0` at 100. IOPS throttle count was 0. No BurstBalance hit 0.

The east 100 adapter `run` JSON was not written. `preparation-attempt3/typical-later-day-20261006/reattach-typical-later-day-1791254457478/run-recovered.json` is a labeled envelope. The east 100 collect is the raw adapter output. East 300 and both west keys have adapter run JSON.

## Attempts that stopped before apply

Two east preparations stopped in preflight with `Regional backend is not explicitly empty`. Execution notes finished at 2026-10-06T02:15:54.193Z and 2026-10-06T02:19:13.629Z. Neither applied a stack or ran load. Their evidence is `typical-later-day-20261006/` at the campaign root, `runner-error.txt`, and `preparation-attempt2/`. The measured east apply is `preparation-attempt3/`.

## Teardown

Both Terraform states are empty (`terraform-empty-state-*.txt`, and `final-cleanup-reconciliation.json` records `bothTerraformStatesEmpty: true` and `liveCleanupConfirmed: true`). Direct checks classified retained ids as `terminated` (3 per region) or `not-found` (east 15, including earlier subnets; west 13). The strict tag inventory was still nonempty at 04:26Z: 14 ARNs in us-east-2 and 16 in us-west-2 (instances, volumes, security-group rules, and one west subnet). The runner exited 1. `recoveryLockRetained` is true. `strictTagInventoryEmpty` is false. This is the same tag-lag pattern as typical-v1: the destroy finished, and the tag catalog had not caught up.

## Redaction

The committed tree is the redacted campaign archive. The AWS account id is `REDACTED` in ARN account segments and elsewhere it appeared. IAM user ARNs, IAM user names, and IAM unique ids are `REDACTED`. App-node public IPs and their `ec2-…` hostnames are `REDACTED`. The EncryptionService debug block in `control-plane-runner.log` is replaced by one placeholder line. Instance, volume, and security-group-rule ids, ALB DNS names, RDS endpoints, AMI ids, and `generator_ip` are kept, as in `typical-v1-20260927c`.
