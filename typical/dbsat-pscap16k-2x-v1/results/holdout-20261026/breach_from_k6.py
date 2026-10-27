#!/usr/bin/env python3
"""Recompute per-UTC-minute steady error rate and P95 from a sealed k6.json.gz (http_req_duration points, phase=steady).
Error = status not 2xx. Prints the minutes and the §3.1 consecutive-over-limit streak."""
import gzip, json, sys, collections, math
p = sys.argv[1]
mins = collections.defaultdict(lambda: [0, 0, []])
with gzip.open(p, 'rt') as f:
    for line in f:
        if '"http_req_duration"' not in line or '"Point"' not in line: continue
        o = json.loads(line); t = o['data']['tags']
        if t.get('phase') != 'steady': continue
        m = o['data']['time'][:16] + ':00Z'
        st = t.get('status', '')
        b = mins[m]; b[0] += 1
        if not st.startswith('2'): b[1] += 1
        b[2].append(o['data']['value'])
streak = 0
for m in sorted(mins):
    n, fail, v = mins[m]; v.sort()
    p95 = v[max(0, math.ceil(0.95 * n) - 1)]
    er = fail / n; over = er > 0.05 or p95 > 2000
    print(m, n, fail, '%.4f' % er, '%.1f' % p95, 'OVER' if over else '')
