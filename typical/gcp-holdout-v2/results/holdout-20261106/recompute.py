#!/usr/bin/env python3
"""gcp-holdout-v2 scorer. Recomputes steady-only latency and error rate from raw
k6 samples and scores against typical/gcp-holdout-v2/PREREGISTRATION.md.

Usage:
  python3 recompute.py raw  <k6.json.gz> <NNN-steady-window.json>   # one rung -> JSON
  python3 recompute.py score <evidence dir> [out.csv]                # all rungs -> CSV + JSON

Latency: nearest-rank ceil(p*N)-1 over http_req_duration points with
start <= t < end of the 900 s steady window (same rule as gcp-holdout-v1).
Cross-check: the same statistics over points tagged phase=steady (steady_p95.py).
Error rate: sum(http_req_failed) / N in the window. Saturated iff > 1%.
Latency band on |pred - meas| / meas: pass <= 20%, marginal <= 35%, else fail;
scored only when error rate <= 1%. Secondary metrics get the same band label
for information only; the prereg does not score them.
"""
import collections, csv, gzip, json, math, os, sys
from datetime import datetime

PRED = {  # frozen, typical/gcp-holdout-v2/PREREGISTRATION.md
    300: dict(p95=68.655389278, p50=11.152871833, app_cpu=26.727293778, db_cpu=42.638881944, conns=74.115343944, sat=False),
    400: dict(p95=86.161019630, p50=11.361998556, app_cpu=33.626288296, db_cpu=54.902027741, conns=110.287478074, sat=False),
    500: dict(p95=103.666649981, p50=11.571125278, app_cpu=40.525282815, db_cpu=67.165173537, conns=146.459612204, sat=False),
}
PRED_BREAKPOINT = 550
LABEL = {300: 'replication', 400: 'replication', 500: 'replication'}


def ts(s):
    s = s.rstrip('Z')
    if '.' in s:
        a, b = s.split('.')
        s = a + '.' + b[:6]
    return datetime.fromisoformat(s).timestamp()


def nr(sorted_vals, p):
    n = len(sorted_vals)
    return sorted_vals[max(0, math.ceil(p * n) - 1)] if n else None


def raw(k6_path, window_path):
    w = json.load(open(window_path))
    s0, s1 = ts(w['start']), ts(w['end'])
    dur, dur_phase = [], []
    status = collections.Counter()
    failed = failed_phase = n_failed_pts = 0.0
    rx = 0.0
    for line in gzip.open(k6_path, 'rt'):
        if '"Point"' not in line:
            continue
        if not ('"http_req_duration"' in line or '"http_req_failed"' in line or '"data_received"' in line):
            continue
        d = json.loads(line)
        m = d['metric']
        data = d['data']
        tags = data.get('tags') or {}
        v = data['value']
        steady_tag = tags.get('phase') == 'steady'
        if m == 'http_req_duration' and steady_tag:
            dur_phase.append(v)
        elif m == 'http_req_failed' and steady_tag:
            failed_phase += v
        t = ts(data['time'])
        if not (s0 <= t < s1):
            continue
        if m == 'http_req_duration':
            dur.append(v)
            status[tags.get('status')] += 1
        elif m == 'http_req_failed':
            failed += v
            n_failed_pts += 1
        elif m == 'data_received':
            rx += v
    dur.sort(); dur_phase.sort()
    n = len(dur)
    span = s1 - s0
    return dict(
        window=w, n=n, rps=n / span, p50=nr(dur, .5), p95=nr(dur, .95), p99=nr(dur, .99),
        failed=int(failed), err_rate=failed / n if n else None, goodput_rps=(n - failed) / span,
        status={str(k): c for k, c in sorted(status.items(), key=lambda kv: str(kv[0]))},
        rx_GB_per_hr=rx / span * 3600 / 1e9,
        phase_steady=dict(n=len(dur_phase), p50=nr(dur_phase, .5), p95=nr(dur_phase, .95),
                          p99=nr(dur_phase, .99),
                          err_rate=failed_phase / len(dur_phase) if dur_phase else None),
    )


def band(pred, meas):
    rel = abs(pred - meas) / meas
    return rel, ('pass' if rel <= 0.20 else 'marginal' if rel <= 0.35 else 'fail')


def score(evidence, out_csv=None):
    reps = sorted(d for d in os.listdir(evidence) if d.startswith('rep') and os.path.isdir(os.path.join(evidence, d)))
    rows = []
    for rep_dir in reps:
        rep = int(rep_dir[3])
        base = os.path.join(evidence, rep_dir)
        placement = json.load(open(os.path.join(base, 'placement.json')))
        for rps in (300, 400, 500):
            cache = os.path.join(base, f'{rps}.recompute.json')
            if os.path.exists(cache):
                r = json.load(open(cache))
            else:
                k6 = os.path.join(base, f'through-{rps}-generator-raw', f'gcp-holdout-{rps}-r{rep}', 'k6.json.gz')
                r = raw(k6, os.path.join(base, f'{rps}-steady-window.json'))
                json.dump(r, open(cache, 'w'))
            c = json.load(open(os.path.join(base, f'{rps}.collect.json')))
            apps = [x['cpuAvgPct'] for x in c['perNode'] if x['role'] == 'app']
            gen = [x['cpuAvgPct'] for x in c['perNode'] if x['role'] == 'generator'][0]
            db = [x['cpuAvgPct'] for x in c['perNode'] if x['role'] == 'database'][0]
            bh = c.get('backendHealth') or {}
            p = PRED[rps]
            sat = r['err_rate'] > 0.01
            row = dict(
                rep=rep, apply_id=c['campaign_id'], generator_zone=placement['generatorZone'],
                app_zones='+'.join(placement['appZones']), measurement_sha=c['gitSha'],
                rung_rps=rps, rung_label=LABEL[rps],
                health_status=bh.get('status'), health_healthy=(bh.get('lastSnapshot') or {}).get('healthyCount'),
                health_expected=bh.get('expectedCount'), health_passed_at=bh.get('passedAt'),
                steady_start=r['window']['start'], steady_end=r['window']['end'],
                n_requests=r['n'], failed_requests=r['failed'], error_rate=r['err_rate'],
                achieved_rps=r['rps'], goodput_rps=r['goodput_rps'],
                steady_p50_ms=r['p50'], steady_p95_ms=r['p95'], steady_p99_ms=r['p99'],
                phase_p95_ms=r['phase_steady']['p95'], phase_n=r['phase_steady']['n'],
                collect_p95_ms=c['latency']['p95Ms'],
                status_counts=json.dumps(r['status'], separators=(',', ':')),
                app_cpu_node_a=apps[0], app_cpu_node_b=apps[1], app_cpu_mean=sum(apps) / len(apps),
                app_cpu_low_high_ratio=min(apps) / max(apps),
                generator_cpu=gen, db_cpu=db,
                db_conn_avg=c['databaseConnections']['avg'], db_conn_max=c['databaseConnections']['max'],
                egress_rx_GB_per_hr_generator=r['rx_GB_per_hr'],
                pred_p95_ms=p['p95'], pred_p50_ms=p['p50'], pred_app_cpu=p['app_cpu'],
                pred_db_cpu=p['db_cpu'], pred_conns=p['conns'],
                pred_saturated='no', measured_saturated='yes' if sat else 'no',
                saturation_verdict='hit' if sat == p['sat'] else 'miss',
                cost_source=c['cost']['source'], cost_verdict='unscored (billing not final)',
            )
            if sat:
                row.update(p95_rel_err='', latency_verdict='unscored (saturated)')
            else:
                rel, b = band(p['p95'], r['p95'])
                row.update(p95_rel_err=rel, latency_verdict=b)
            for key, pk, mk in (('p50', 'p50', r['p50']), ('app_cpu', 'app_cpu', row['app_cpu_mean']),
                                ('db_cpu', 'db_cpu', db), ('conns', 'conns', row['db_conn_avg'])):
                rel, b = band(p[pk], mk)
                row[f'{key}_rel_err'] = rel
                row[f'{key}_band_info'] = b
            rows.append(row)
    # cross-rep mean only when both reps latency-scored
    means = {}
    for rps in (300, 400, 500):
        rr = [x for x in rows if x['rung_rps'] == rps]
        if len(rr) == 2 and all(x['latency_verdict'] != 'unscored (saturated)' for x in rr):
            m = sum(x['steady_p95_ms'] for x in rr) / 2
            rel, b = band(PRED[rps]['p95'], m)
            means[rps] = dict(mean_p95_ms=m, rel_err=rel, verdict=b)
    # measured breakpoint per rep
    bps = {}
    for rep in sorted({x['rep'] for x in rows}):
        flags = [x['measured_saturated'] == 'yes' for x in sorted((y for y in rows if y['rep'] == rep), key=lambda y: y['rung_rps'])]
        if not any(flags):
            bracket, lo, hi = '> 500', 500, math.inf
        elif flags != sorted(flags):
            bracket, lo, hi = 'non-monotonic (undetermined)', None, None
        else:
            i = flags.index(True)
            lo = (300, 400, 500)[i - 1] if i else None
            hi = (300, 400, 500)[i]
            bracket = f'({lo}, {hi}]' if lo else '<= 300'
        if lo is None and hi is None:
            verdict = 'not scored'
        else:
            verdict = 'hit' if ((lo is None or PRED_BREAKPOINT > lo) and PRED_BREAKPOINT <= hi) else 'miss'
        bps[rep] = dict(bracket=bracket, verdict=verdict)
    if out_csv:
        with open(out_csv, 'w', newline='') as fh:
            wr = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            wr.writeheader()
            for row in rows:
                wr.writerow({k: (f'{v:.9g}' if isinstance(v, float) else v) for k, v in row.items()})
    print(json.dumps(dict(rows=rows, cross_rep_means=means, breakpoints=bps), indent=1, default=str))


if __name__ == '__main__':
    if sys.argv[1] == 'raw':
        print(json.dumps(raw(sys.argv[2], sys.argv[3])))
    else:
        score(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
