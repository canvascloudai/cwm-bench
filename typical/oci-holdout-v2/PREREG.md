# OCI holdout v2 — bootstrap amendment

Date: 2026-11-26, before any v2 measurement data collection.
This amends [PREREGISTRATION.md](PREREGISTRATION.md); operational rehearsals
are excluded from holdout evidence.

Bootstrap hardening (DNS wait, Ksplice repo excluded, offline firewall config, bounded timeouts). Operational only; no change to topology, load ladder, measurement, collection or scoring.

## Operational recovery amendment — 2026-11-27

Recorded before valid holdout collection on the new recovery date. Earlier
invalid or incomplete attempts and all rehearsal data remain excluded.

The exact pinned `scripts/lib/adapter/oci-raw.py` runs locally on the privately
retained, SHA-256-verified `k6.json.gz`, `summary.json` and `complete.json`.
The parser bytes, input bytes, identity checks and parser output are unchanged.
There is no remote parser call and no replay of a completed workload.

The approved recovery date fence is `20261127` (UTC). Start fresh r1 no later
than `2026-11-27T13:00:00Z`; start r2 on the same UTC day only after r1 destroy
and a clean immediate sweep. No backdating or reuse of retired apply IDs.

Retain consumed replacement counts and carry all conservative campaign spend,
including invalid attempts, the operational rehearsal and cleanup, forward.
The $100 campaign-total pause-and-ask soft cap and informational $15/$25 alerts
remain unchanged. Operational only: no change to topology, ID grammar, frozen
load ladder or timings, measurement/collection windows, scoring, gates or bands.
