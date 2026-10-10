# Raw typical-scale-v1 execution

Parent: typical-scale-v1-20261006
Measurement SHA: 06e4048d9c6db5494dbb85da2911de4943a70383
AMI: ami-0d3d85815a9746bc5
First apply starts by session (UTC, including failed applies): 2026-10-06T19:08:58.245Z, 2026-10-07T19:15:11.477Z, 2026-10-08T23:23:57.099Z
Finished: 2026-10-09T19:23:51.397Z

Completed cells: 9
Total attempted applies, including preserved failures: 10

Cells ran in Latin-square order with fresh applies and 100 → 200 → 300 ladders.
Historical holdout lock untouched. No CWM engine queries, scoring, metric commentary, retuning, or coefficient changes.
All run/collect attempts and failed preparations are retained. Generator markers supplied exact collect bounds; no trailing fallback was accepted.

## Exact RDS engine identifiers

Sessions 1–2 reported: `8.0.46`.
Session 3 reported: `8.0.46-rds.20260908`.
Different reported build identifiers from sessions 1–2: `8.0.46-rds.20260908`.
These are verbatim AWS identifiers; no suffix was removed and no performance interpretation is provided.

| Apply | Actual apply start UTC | Exact EngineVersion | Outcome | Raw version evidence |
| --- | --- | --- | --- | --- |
| typical-scale-2x-r1-20261006 | 2026-10-06T19:08:58.245Z | 8.0.46 | completed | 03-rds-engine-version-1791314206329.json |
| typical-scale-1x-r1-20261006 | 2026-10-06T20:43:17.954Z | 8.0.46 | completed | 03-rds-engine-version-1791319878484.json |
| typical-scale-3x-r1-20261006 | 2026-10-06T22:20:29.188Z | 8.0.46 | completed | 03-rds-engine-version-1791325708331.json |
| typical-scale-1x-r2-20261007 | 2026-10-07T19:15:11.477Z | 8.0.46 | completed | 03-rds-engine-version-1791400984670.json |
| typical-scale-3x-r2-20261007 | 2026-10-07T20:49:50.510Z | 8.0.46 | completed | 03-rds-engine-version-1791406686736.json |
| typical-scale-2x-r2-20261007 | 2026-10-07T22:26:05.538Z | 8.0.46 | completed | 03-rds-engine-version-1791412439802.json |
| typical-scale-3x-r3-20261008 | 2026-10-08T23:23:57.099Z | 8.0.46-rds.20260908 | failed/incomplete | 03-rds-engine-version-1791502348295.json |
| typical-scale-3x-r3a-20261009 | 2026-10-09T14:22:23.079Z | 8.0.46-rds.20260908 | completed | 03-rds-engine-version-1791556283736.json |
| typical-scale-2x-r3-20261009 | 2026-10-09T16:03:40.054Z | 8.0.46-rds.20260908 | completed | 03-rds-engine-version-1791562294007.json |
| typical-scale-1x-r3-20261009 | 2026-10-09T17:50:52.232Z | 8.0.46-rds.20260908 | completed | 03-rds-engine-version-1791568729495.json |

## Execution problems and recovery

- Initial pre-apply preparation was interrupted before any apply or load; its evidence is retained.
- Read-only overnight due timers were interrupted by workspace restarts. No running measurement was interrupted by those timer restarts.
- Session 3 encountered three stopped preflight attempts due to AWS CLI read timeouts. All responses, controller logs and stopped-state snapshots are retained. Two consecutive healthy read-only rounds preceded the successful full cleanup preflight.
- The original three-app session 3 apply passed app readiness but the controller's numeric-only version validator rejected `8.0.46-rds.20260908`. No load ran on that apply; it was destroyed and checked immediately and after 15 minutes in both regions.
- The creator approved recognition of AWS's documented MySQL 8.0 RDS patch format and one fresh `r3a` replacement. The failed apply remains evidence. Terraform defaults, AMI, source SHA, profile, workers, pool size, database connection limit, workload order and timings were unchanged. RDS Extended Support charges were disclosed before approval.
- The delayed-cleanup helper's temporary console log was unavailable after the overnight pause. Its durable AWS command outputs, JSON records and successful cleanup proofs remain preserved.
- Per-apply raw attempt records document any load retry or incomplete collect. Retried outputs are separate evidence, never overwritten.

See verification/ for preparation failures, workspace interruption records, connectivity checks, creator approvals and controller logs; see each apply directory for outputs, exact versions, run/collect JSONs and cleanup proofs.
