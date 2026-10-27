#!/usr/bin/env python3
"""Score typical-dbsat-pscap16k-2x-v1 per its PREREGISTRATION.md section 5 from the observer polls.
Input: <attempt>/out/diagnostic-time-series.json. Only observer poll samples are used."""
import json, sys, datetime as dt, collections
C = 59.10268577018286
CAP = 16382
def ts(s): return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
def errno(sample, n):
    for e in sample.get('errors', []):
        if e['ERROR_NUMBER'] == n: return int(e['SUM_ERROR_RAISED'])
    return 0
def score(path):
    d = json.load(open(path))
    S = sorted(d['samples'], key=lambda s: s['at'])
    rows = []
    for i, s in enumerate(S):
        rows.append(dict(i=i, at=s['at'], mode=s.get('mode'), threads=int(s['status']['Threads_connected']),
                         prep=int(s['status']['Prepared_stmt_count']), e1461=errno(s,1461), e1040=errno(s,1040),
                         pred=C*int(s['status']['Threads_connected']), maxstmt=s.get('max_prepared_stmt_count')))
    base1461 = rows[0]['e1461']
    cross = next((r for r in rows if r['pred'] >= CAP), None)
    onset = next((r for r in rows if r['e1461'] > base1461), None)
    out = dict(campaign=d['campaign'], polls=len(rows), modes=dict(collections.Counter(r['mode'] for r in rows)),
               first_poll=rows[0]['at'], base1461=base1461, c=C)
    if cross: out['cross'] = dict(idx=cross['i'], at=cross['at'], threads=cross['threads'], pred=cross['pred'], prep=cross['prep'])
    if onset: out['onset'] = dict(idx=onset['i'], at=onset['at'], threads=onset['threads'], prep=onset['prep'], e1461=onset['e1461'], pred=onset['pred'])
    out['peak_prep'] = max(r['prep'] for r in rows)
    out['peak_prep_at'] = next(r['at'] for r in rows if r['prep'] == out['peak_prep'])
    out['peak_threads'] = max(r['threads'] for r in rows)
    out['max_stmt_values'] = sorted({r['maxstmt'] for r in rows})
    if cross and onset:
        out['onset_minus_cross_polls_index'] = onset['idx'] - cross['idx'] if False else onset['i'] - cross['i']
        out['onset_minus_cross_seconds'] = (ts(onset['at']) - ts(cross['at'])).total_seconds()
        out['pre_window_1461_max'] = max([r['e1461'] for r in rows if r['i'] <= cross['i'] - 2] or [0]) - base1461
    gaps = [(ts(rows[i]['at']) - ts(rows[i-1]['at'])).total_seconds() for i in range(1, len(rows))]
    out['max_gap_s'] = max(gaps)
    out['rows'] = rows
    return out
if __name__ == '__main__':
    r = score(sys.argv[1]); rows = r.pop('rows'); print(json.dumps(r, indent=1))
    if len(sys.argv) > 2:
        for x in rows:
            print(x['i'], x['at'], x['mode'], x['threads'], x['prep'], round(x['pred']), x['e1461'])
