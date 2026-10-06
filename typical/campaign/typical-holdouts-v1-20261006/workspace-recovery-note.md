# Workspace interruption

The workspace restart was detected at 2026-10-06T02:34:53Z during the first
`typical-later-day` attempt, whose local start record is 2026-10-06T02:29:13.425Z.
The original local process and its buffered, not-yet-written adapter run output
were lost. No completed local run JSON existed at the time of the restart.

Read-only inspection found the original detached workload still running with
the expected campaign, scenario, and run identity. The immutable checkout and
post-apply stack identity were checked again. Bounded reattachment recovered
that same attempt's terminal evidence; no replacement 100-RPS load was launched.

The `recovery-*` and `reattach-*` directories contain the interruption record,
remote identity, SSM command evidence, terminal result, and a clearly labeled
`run-recovered.json` envelope. The collect JSON is the raw public adapter output.
