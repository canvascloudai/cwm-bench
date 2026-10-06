# Raw typical holdouts — typical-holdouts-v1-20261006

Executed for the mathsociety user on 2026-10-06 UTC. All timestamps below are UTC.
Pinned checkout and app_source_git_ref: 64c6e89d74e25c549e7dad740471443621da5aac. Both wait-ready gates reported adapter 1.4.0 and two typical app nodes, each with 2 workers and that exact SHA. The frozen original 1.3.0 runner was not modified.

Campaigns: typical-later-day-20261006 and typical-second-region-20261006, under typical-holdouts-v1-20261006. Separate Terraform work directories and backend schemas were used.

## Execution

| Region | Key | Load command started | Remote load completed | Attempts |
|---|---|---|---|---|
| us-east-2 | typical-later-day | 2026-10-06T02:29:13.425Z | 2026-10-06T02:49:21Z | 1 |
| us-east-2 | typical-later-day-300 | 2026-10-06T02:50:24.412Z | 2026-10-06T03:10:36Z | 1 |
| us-west-2 | typical-second-region | 2026-10-06T03:23:48.586Z | 2026-10-06T03:43:56Z | 1 |
| us-west-2 | typical-second-region-300 | 2026-10-06T03:45:01.967Z | 2026-10-06T04:05:23Z | 1 |

- us-east-2: apply 2026-10-06T02:21:08.680Z → 2026-10-06T02:28:10.556Z; destroy confirmed 2026-10-06T03:14:22.480Z.
- us-west-2: apply 2026-10-06T03:15:25.451Z → 2026-10-06T03:22:31.973Z; destroy confirmed 2026-10-06T04:10:51.556Z.

In each apply, the 100 key ran before the 300 key, then destroy. CWM_FIT_CAMPAIGN_DATE=2026-09-27 was set for both east keys; unset for west. CWM_RUN_ID and warmup/duration overrides were unset for load commands. Collect alone was scoped to the generated run ID. No load retries or incomplete-collect retries were needed.

## Problems and cleanup

- Two pre-apply setup stops concerned Terraform's initial absent PostgreSQL state and ANSI-formatted output; all evidence is retained. No cloud apply or load attempt occurred during those stops.
- A workspace restart interrupted the east 100 control process. The existing detached workload was reattached as the same attempt, not rerun. Its original buffered run response was lost; the explicitly labeled run-recovered.json and remote evidence are retained. See workspace-recovery-note.md.
- Immediate and approximately 15-minute post-destroy inventories were recorded in both regions after each destroy. Both Terraform states are empty. Final direct inventories found no live campaign instances, databases, volumes, or security-group rules.
- AWS's tagging inventory remained nonempty. Direct checks classified every retained ID as not-found or terminated, with no unresolved IDs. Original strict cleanup failure and snapshots are preserved. final-cleanup-reconciliation.json records the separate direct confirmation. The runner's strict safety lock is retained; the tag catalog is not represented as empty.

All saved run/collect JSONs, failed preparation/control evidence, and cleanup evidence are included under out/. No metrics were scored or interpreted, no retuning was performed, and no coefficients were changed. Private checkouts, credentials, Terraform plans, state, and backend metadata are excluded.
