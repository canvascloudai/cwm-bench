#!/usr/bin/env python3
"""Usage: build_scores.py <attempts-dir> <outdir>. Writes scores.json and poll-series-<rep>.csv from the sealed observer polls."""
import json, sys, csv
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from score_pscap16k import score
A, O = Path(sys.argv[1]), Path(sys.argv[2])
REPS = {'r1b': 'attempt-r1b-pre2-0', 'r2': 'attempt-r2initial-pre0-0'}
res = {}
for rep, d in REPS.items():
    r = score(str(A / d / 'out' / 'diagnostic-time-series.json')); rows = r.pop('rows'); res[rep] = r
    with open(O / f'poll-series-{rep}.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['idx', 'at_utc', 'mode', 'Threads_connected', 'Prepared_stmt_count', 'c_x_threads', 'errno_1461_cumulative', 'errno_1040_cumulative'])
        for x in rows: w.writerow([x['i'], x['at'], x['mode'], x['threads'], x['prep'], round(x['pred'], 3), x['e1461'], x['e1040']])
(O / 'scores.json').write_text(json.dumps(res, indent=1) + '\n')
