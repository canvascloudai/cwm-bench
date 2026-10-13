# Raw typical-p95-v1 execution
Parent: typical-p95-v1-20261010
Measurement SHA: 0815668ced5c219313b02efba0279ef2ae55fa0c
Adapter: 1.6.1
Controller: 1.0.3; SHA256 374e8eba727b96eafddcf8e15f90e90ef37b05ce8caa984e8fce2afbeaa4c848
Pinned AL2023 AMI: ami-0d3d85815a9746bc5
UTC session days: {"1":"2026-10-10","2":"2026-10-11","3":"2026-10-12"}
Finished UTC: 2026-10-12T22:18:28.912Z
No scoring, engine queries, metric commentary, thresholds, retuning, or coefficient changes.
Reverse ladders 300 → 200 → 100; no rung retries. Whole-apply replacements and failed attempts are retained.
All resources destroyed; immediate and at-least-15-minute checks confirmed in both regions.
Spend guard is a conservative upper bound, not actual billed spend; its frozen basis is in verification/.
| Apply | Start UTC | Exact RDS EngineVersion | Valid | Replacement |
| --- | --- | --- | --- | --- |
| typical-p95-1x-r1-20261010 | 2026-10-10T16:08:14.602Z | 8.0.46-rds.20260908 | false | none |
| typical-p95-2x-r1-20261010 | 2026-10-10T17:07:20.993Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-3x-r1-20261010 | 2026-10-10T18:51:56.664Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-1x-r1a-20261010 | 2026-10-10T20:38:57.532Z | 8.0.46-rds.20260908 | true | a |
| typical-p95-2x-r2-20261011 | 2026-10-11T16:21:31.264Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-3x-r2-20261011 | 2026-10-11T18:09:08.985Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-1x-r2-20261011 | 2026-10-11T19:58:15.524Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-3x-r3-20261012 | 2026-10-12T16:36:29.163Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-1x-r3-20261012 | 2026-10-12T18:50:35.322Z | 8.0.46-rds.20260908 | true | none |
| typical-p95-2x-r3-20261012 | 2026-10-12T20:43:26.305Z | 8.0.46-rds.20260908 | true | none |
See per-apply rungs/ for summary.json, k6.json.gz and download hashes. All operational failures and cleanup proofs are retained.
