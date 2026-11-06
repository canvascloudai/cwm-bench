import gzip, json, sys, math, collections
from datetime import datetime

f, w = sys.argv[1], json.load(open(sys.argv[2]))

def ts(s):
    s = s.rstrip('Z')
    if '.' in s:
        a, b = s.split('.')
        s = a + '.' + b[:6]
    return datetime.fromisoformat(s).timestamp()

s0, s1 = ts(w['start']), ts(w['end'])
dur = []
st = collections.Counter()
rx = 0
tx = 0
failed = 0
for line in gzip.open(f, 'rt'):
    if '"Point"' not in line:
        continue
    d = json.loads(line)
    m = d['metric']
    if m not in ('http_req_duration', 'data_received', 'data_sent', 'http_req_failed'):
        continue
    t = ts(d['data']['time'])
    if not (s0 <= t < s1):
        continue
    v = d['data']['value']
    if m == 'http_req_duration':
        dur.append(v)
        st[d['data']['tags'].get('status')] += 1
    elif m == 'data_received':
        rx += v
    elif m == 'data_sent':
        tx += v
    else:
        failed += v
dur.sort()
N = len(dur)
nr = lambda p: dur[max(0, math.ceil(p * N) - 1)]
print(json.dumps(dict(
    n=N,
    rps=N / (s1 - s0),
    p50=nr(.5),
    p95=nr(.95),
    p99=nr(.99),
    err_rate=failed / N,
    status=dict(st),
    rx_bytes=rx,
    tx_bytes=tx,
    rx_GB_per_hr=rx / (s1 - s0) * 3600 / 1e9,
)))
