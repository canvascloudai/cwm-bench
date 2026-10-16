OWNER-APPROVED, NON-PREREG DIAGNOSTIC ONLY — NOT DISCOVERY OR CONFIRMATION
Measurement SHA: 881e0cffd51da084be4a24ffd13366dfbb67063f
Diagnostic controller manifest SHA256: 2200cbc136e297799b718cdb4fc9c7e35f33acbfd82559d4e725caaeef407076 (unchanged).
4 app nodes; 1 generator; frozen 0.5/2.5 s VU settings; no app/load changes or rung retries.
Rung starts (UTC): 300 at 18:58:15; 500 at 19:28:36; 700 at 20:05:12, 2026-10-16.
The 700 monitor recorded breach at 20:14:07.396 UTC, after failing eligible minutes 20:11, 20:12, 20:13. See retained monitor rows; this is not a scored result.
Breach handling hit the shadowed-variable hook defect. Aborted preservation could not find the required original gzip/exit.code. No breach-time InnoDB or error-top20 snapshot was captured. Neither bug has been fixed.
300 and 500 raw outputs were retained normally. For 700 the original gzip was absent; its surviving uncompressed raw file (1613407683 bytes) was recovered as a separately labelled recovery-only gzip. Compressed SHA256 and decompressed original-file SHA256 were both checked. Its surviving summary and runner metadata remain private.
All 4 private app journal captures and 324 DB samples were retained via verified transfer. Journal capture does not supply endpoint MySQL errno logs: those counts remain unavailable.
prepared-limit-and-1461-by-minute.csv is the requested joined minute table. It retains sampled min/max/last Prepared_stmt_count, configured limit, sample count and delta interval boundaries. Blank first-baseline counts mean unavailable, not zero. First and last minutes may be partial. Counter deltas are assigned to the UTC minute of their interval END; exact boundaries are included. The 15 s cadence is discrete sampling, not continuous measurement.
mysql-errors-by-minute.csv includes all observed global MySQL counter changes; codes other than 1461 can include warnings. They are not per-endpoint errno attribution.
http-outcomes-all-rungs-by-minute.csv includes 300/500 retained raw plus the recovered 700 request_outcomes, using only templated endpoint, UTC minute, status and class. The final 700 minute is partial. MySQL errno is explicitly unavailable.
The current SQL snapshot was taken at 2026-10-16T20:34:51.002Z. It is POST-RUN, NOT BREACH-TIME. Error counts in that separate snapshot are cumulative, not minute deltas. No values were backfilled into the earlier time series.
One extra non-pooled text-protocol DB observation connection was used; no prepared queries were created by the observer.
Private raw k6, app/bootstrap/journal logs, raw SQL snapshots, console logs, state/mirrors and credential-bearing files are excluded from this report archive and remain private.
Destroyed: 2026-10-16T20:37:55.642Z; immediate both-region cleanup: 2026-10-16T20:39:18.921Z; delayed both-region cleanup: 2026-10-16T20:54:20.596Z (984.954 seconds after destroy).
Recovery ran NO load. Both us-east-2 and us-west-2 cleanup checks passed. Original interrupted journal is byte-identical. No discovery/confirmation/new apply is authorized. PAUSED.
