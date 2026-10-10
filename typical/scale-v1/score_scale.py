#!/usr/bin/env python3
"""Score typical-scale-v1 against the frozen engine-1.2.14 predictions
(typical/scale-v1/predictions/predictions.json) per typical/scale-v1/PREREGISTRATION.md
§5.3, §6, §7.1-§7.4. rel, errs and W are loaded unchanged (AST-extracted, source-verified)
from typical/after-fit/score_export.py. Reads only local files; never queries the engine.
Usage: python3 score_scale.py <archive out dir> <cwm-bench repo dir> <output dir>"""
import json, os, sys, glob, ast, csv, re, statistics as st
OUT, REPO, DEST = sys.argv[1], sys.argv[2], sys.argv[3]
SHA = '06e4048d9c6db5494dbb85da2911de4943a70383'; AMI = 'ami-0d3d85815a9746bc5'

# ---- rel / errs / W unchanged from score_export.py ----
src = open(f'{REPO}/typical/after-fit/score_export.py').read()
tree = ast.parse(src); ns = {}
for node in tree.body:
    if (isinstance(node, ast.FunctionDef) and node.name in ('rel', 'errs')) or \
       (isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'W' for t in node.targets)):
        exec(compile(ast.Module([node], []), 'score_export.py', 'exec'), ns)
rel, errs, W = ns['rel'], ns['errs'], ns['W']
REFN = {1: 0.3585, 2: 0.4545, 3: 0.5505}   # §7.1 list-price reference, 0.0225 + N*0.096 + 0.24
def score(p, M, cost_pred, ref):
    sc = {k: round(rel(p[k], M[k]), 1) for k in ['p50', 'p95', 'cpu', 'thr']}
    sc['err'] = round(errs(p['err'], M['err']), 1)
    sc['cost'] = round(rel(cost_pred, ref), 1)
    tot = round(sum(W[k] * sc[k] for k in W), 1)
    noc = round(sum(W[k] * sc[k] for k in W if k != 'cost') / 0.9, 1)
    return sc, tot, noc

PRED = json.load(open(f'{REPO}/typical/scale-v1/predictions/predictions.json'))
assert PRED['engineVersion'] == '1.2.14'
def pred(n, r):
    c = PRED['cells'][f'{n}x-{r}']
    return dict(cpu=c['appCpuPerHost'], p50=c['latencyP50'], p95=c['latencyP95'], p99=c['latencyP99'],
                thr=c['throughput'], err=c['errorRate'], db=c['dbCpu'], cost=c['costPerHour'],
                costSum=c['costBreakdownTotal'], kind=c['calibrationEvidence']['kind'], engine=c['engineVersion'],
                fleetBudget=n * 250, warnings=c.get('warnings', []))
NAIVE = {(n, r): round(0.45291 + 0.095246 * r / n, 3) for n in (1, 2, 3) for r in (100, 200, 300)}  # §5.3

SESS = {1: {1: 'typical-scale-1x-r1-20261006', 2: 'typical-scale-2x-r1-20261006', 3: 'typical-scale-3x-r1-20261006'},
        2: {1: 'typical-scale-1x-r2-20261007', 2: 'typical-scale-2x-r2-20261007', 3: 'typical-scale-3x-r2-20261007'},
        3: {1: 'typical-scale-1x-r3-20261009', 2: 'typical-scale-2x-r3-20261009', 3: 'typical-scale-3x-r3a-20261009'}}
ALL_APPLIES = sorted(d for d in os.listdir(OUT) if d.startswith('typical-scale-') and os.path.isdir(f'{OUT}/{d}'))
FAIL = []
def chk(cond, msg):
    if not cond: FAIL.append(msg)
    return bool(cond)
def j(p): return json.load(open(p))
def one(pat):
    g = sorted(x for x in glob.glob(pat) if re.search(r'\d\.json$|\d\.txt$|outputs\.json$', x)); return g[-1] if g else None

# ---- per-apply checks ----
APPLY = {}
for a in ALL_APPLIES:
    d = f'{OUT}/{a}'; n = int(a.split('-')[2][0])
    tf = j(f'{d}/01-terraform-outputs.json')
    rds = j(one(f'{d}/03-rds-engine-version-*.json'))['DBInstances']
    ev = [x['EngineVersion'] for x in rds]
    wr = j(one(f'{d}/02-wait-ready-*.json'))
    shas = set(open(one(f'{d}/git-sha-*.txt')).read().split())
    A = dict(apply=a, n=n, engineVersions=ev, autoMinorUpgrade=[x.get('AutoMinorVersionUpgrade') for x in rds],
             amiId=tf['resolved_ami_id']['value'], amiSource=tf['ami_source']['value'],
             appCount=tf['topology_declaration']['value']['app_count'], appIds=len(tf['app_instance_ids']['value']),
             poolSize=tf['topology_declaration']['value']['app_pool_size'],
             maxConn=tf['topology_declaration']['value']['mysql_max_connections'],
             gitSha=sorted(shas), waitReadyOk=wr.get('ok'), adapter=wr.get('adapterVersion'),
             appNodes=wr.get('appNodes', []), started=j(f'{d}/01-apply-started.json'))
    pre = f'apply {a}'
    chk(A['amiId'] == AMI and A['amiSource'] == 'variable', f'{pre}: AMI {A["amiId"]}/{A["amiSource"]}')
    chk(A['appCount'] == n and A['appIds'] == n, f'{pre}: app_count {A["appCount"]} ids {A["appIds"]} != {n}')
    chk(shas == {SHA}, f'{pre}: git sha {shas}')
    chk(A['poolSize'] == 250 and A['maxConn'] == 500, f'{pre}: pool/max_conn {A["poolSize"]}/{A["maxConn"]}')
    chk(A['waitReadyOk'] and A['adapter'] == '1.5.0', f'{pre}: wait-ready ok/adapter')
    chk(len(A['appNodes']) == n and all(x['profile'] == 'typical' and x['workers'] == 2 and x['gitSha'] == SHA for x in A['appNodes']),
        f'{pre}: appNodes')
    chk(len(ev) == 1, f'{pre}: {len(ev)} RDS instances matched')
    APPLY[a] = A

# ---- per-rung extraction ----
def per_minute(series):
    return sorted(((x['timestamp'][11:16], x['maximum'] if x['maximum'] is not None else x['average']) for x in series))
def measured(path, n, rps):
    d = j(path)
    app = [x['cpuAvgPct'] for x in d['perNode'] if x['role'] == 'app']
    db = [x['cpuAvgPct'] for x in d['perNode'] if x['role'] == 'database'][0]
    gen = [x['cpuAvgPct'] for x in d['perNode'] if x['role'] == 'generator'][0]
    cw = d['cloudwatch']['metrics']
    gdp = [x['maximum'] if x['maximum'] is not None else x['average'] for x in cw['generator_cpu']['datapoints']]
    conn = per_minute(cw['rds_connections']['datapoints'])
    cmax = max(conn, key=lambda t: t[1]) if conn else (None, None)
    k6 = d['artifacts']['k6']; e5 = cw['alb_http_elb_5xx']['summary']
    return dict(scenario=d['scenario'], runId=d['runId'], campaignId=d['campaignId'], adapter=d['adapterVersion'],
        cpu=sum(app) / len(app), cpuPerHost=app, db=db, dbConnMax=d['databaseConnections']['max'],
        dbConnAvg=d['databaseConnections']['avg'], dbConnSaturation=d['databaseConnections'].get('saturation'),
        dbConnSpikeMinuteUtc=cmax[0], dbConnSpikeMax=cmax[1], dbConnMinuteMin=min(v for _, v in conn) if conn else None,
        dbConnPerMinute=conn,
        p50=d['latency']['p50Ms'], p95=d['latency']['p95Ms'], p99=d['latency']['p99Ms'],
        albP50=d['albLatency']['p50Ms'], albP95=d['albLatency']['p95Ms'], albP99=d['albLatency']['p99Ms'],
        thr=d['goodputRps'], goodputPct=d['goodputRps'] / rps * 100, httpReqs=k6['httpReqs']['count'],
        failed=k6['httpReqFailed']['passes'], err=k6['httpReqFailed']['rate'] * 100,
        errorClasses={k: v for k, v in d['errorCategories'].items() if v},
        albElb5xx=e5['value'] if e5['available'] else 0, genCpuAvg=gen, genCpuPeak=max(gdp) if gdp else None,
        burstRds=d['burstBalanceMin']['rds'], burstApp=min(v['min'] for v in d['burstBalanceMin']['appVolumes']),
        ok=d['ok'], complete=d['complete'], invented=d['invented'], identityMatches=d['artifacts']['identityMatches'],
        topoAppCount=d['terraformOutputs']['topology_declaration']['app_count'],
        nAppIds=len(d['terraformOutputs']['app_instance_ids']), nAppPerNode=len(app),
        amiId=d['resolvedAmis']['amiId'], amiSource=d['resolvedAmis']['source'],
        window=d['cloudwatch']['window'], cwQueryFailures=len(d['cloudwatch'].get('queryFailures', [])))

R = {}  # (n, rps, k) -> rung dict
for k, row in SESS.items():
    for n, a in row.items():
        for rps in (100, 200, 300):
            key = f'typical-scale-{n}x-{rps}'; d = f'{OUT}/{a}'; tag = f'{a}/{key}'
            cp = f'{d}/11-{key}.collect.json'
            if not chk(os.path.exists(cp), f'{tag}: collect missing'): continue
            M = measured(cp, n, rps)
            run = j(f'{d}/10-{key}.run.json'); att = j(f'{d}/12-{key}.attempt.json')
            vus = [int(x) for x in re.findall(r'running \([^)]*\), (\d+)/\d+ VUs', run.get('remoteStdout', ''))]
            M.update(peakVUs=max(vus) if vus else None, runOk=run['ok'], runAdapter=run['adapterVersion'],
                     attempt=att['attempt'], retry=att['retry'], historyPerturbed=att['historyPerturbed'],
                     bounds=att['bounds'], session=k, apply=a, rds=APPLY[a]['engineVersions'][0],
                     extraAttempts=sorted(os.path.basename(x) for x in glob.glob(f'{d}/*{key}*attempt2*')))
            chk(M['scenario'] == key and M['runId'] == f'{key}-r{k}', f'{tag}: scenario/runId {M["scenario"]}/{M["runId"]}')
            chk(M['ok'] and M['complete'] and M['identityMatches'] and M['invented'] is False, f'{tag}: ok/complete/identity/invented')
            chk(M['adapter'] == '1.5.0' and M['runAdapter'] == '1.5.0' and M['runOk'], f'{tag}: adapter/run ok')
            chk(M['topoAppCount'] == n and M['nAppIds'] == n and M['nAppPerNode'] == n, f'{tag}: app_count')
            chk(M['window']['source'] == 'persisted-run', f'{tag}: window source {M["window"]["source"]}')
            chk(M['window']['actualStartTime'][:19] == M['bounds']['start'][:19] and M['window']['actualEndTime'][:19] == M['bounds']['end'][:19],
                f'{tag}: window != generator bounds')
            chk(M['genCpuAvg'] <= 70 and (M['genCpuPeak'] or 0) <= 70, f'{tag}: generator CPU {M["genCpuAvg"]:.1f}/{M["genCpuPeak"]}')
            chk(M['amiId'] == AMI and M['amiSource'] == 'variable', f'{tag}: collect AMI')
            chk(M['cwQueryFailures'] == 0, f'{tag}: cloudwatch query failures')
            R[(n, rps, k)] = M
chk(len(R) == 27, f'{len(R)} rungs, expected 27')

MET = ['cpu', 'p50', 'p95', 'p99', 'thr', 'goodputPct', 'err', 'db', 'dbConnMax']
def reps(n, r, m): return [R[(n, r, k)][m] for k in (1, 2, 3)]
def med(n, r, m): return st.median(reps(n, r, m))

# ---- §7.1 absolute ----
scores = {}
for n in (1, 2, 3):
    for r in (100, 200, 300):
        P = pred(n, r); Mm = {m: med(n, r, m) for m in MET}
        role = 'validation' if n != 2 else ('fit-condition repeat' if r < 300 else 'holdout-condition repeat')
        cell = dict(role=role, calibration=P['kind'], engine=P['engine'], pred={k: P[k] for k in ['cpu','p50','p95','p99','thr','err','db','cost','costSum','fleetBudget']},
                    meas=dict(**{m: Mm[m] for m in MET}, cost=REFN[n]),
                    measReps={m: reps(n, r, m) for m in MET}, measMin={m: min(reps(n, r, m)) for m in MET},
                    measMax={m: max(reps(n, r, m)) for m in MET})
        nb = round(REFN[n], 4)
        for basis, cp in (('connectorCostBasis', P['cost']), ('noEgressCostBasis', nb)):
            sc, tot, noc = score(P, Mm, cp, REFN[n])
            per = [score(P, {m: R[(n, r, k)][m] for m in MET}, cp, REFN[n]) for k in (1, 2, 3)]
            cell[basis] = dict(costPred=cp, scores=sc, total=tot, withoutCost=noc,
                               perRepTotals=[x[1] for x in per], perRepTotalMin=min(x[1] for x in per), perRepTotalMax=max(x[1] for x in per),
                               perRepNoCost=[x[2] for x in per], perRepNoCostMin=min(x[2] for x in per), perRepNoCostMax=max(x[2] for x in per))
        cell['noEgressCostBasis']['costPredDerived'] = 'non-egress list-price lines 0.0225 + N*0.096 + 0.24; predictions.json has no egress split'
        cell['p99DiagnosticScore'] = round(rel(P['p99'], Mm['p99']), 1)
        cell['naiveCpuReference'] = NAIVE[(n, r)]
        scores[f'{n}x-{r}'] = cell

# ---- §6 C1 baseline (existing 2x runs, typical/scores-*.json) ----
EXIST = {100: [dict(cpu=5.238137291849269, p50=4.684795, p95=8.354502, thr=87.62279003099846, err=0.002853039914028397, db=11.492307692307692),
               dict(cpu=5.461536845099605, p50=5.439607, p95=9.7898165, thr=87.6253492297855, err=0.0, db=13.473813450609272),
               dict(cpu=5.72531975451282, p50=4.531484, p95=7.629682399999997, thr=87.6215288088677, err=0.002853094180638903, db=12.614102564102563)],
         200: [dict(cpu=9.967308023757205, p50=4.6089649999999995, p95=11.400343699999972, thr=175.11042969554555, err=0.006186057577920533, db=18.563463853285263)],
         300: [dict(cpu=15.303205128205128, p50=4.621661, p95=26.917676599999997, thr=262.60872607647724, err=0.0044423431456231816, db=26.709615384615383),
               dict(cpu=15.813503285780286, p50=5.175492, p95=51.122386600000034, thr=262.55196121325883, err=0.006664614388585103, db=31.418488497715792),
               dict(cpu=16.085248562592426, p50=4.621589, p95=32.88688839999976, thr=262.6124176163182, err=0.003807722696248441, db=29.269852842091094)]}
B = {'cpu': {100: 1.093, 300: 1.051, 200: 1.093}, 'p50': {100: 1.200, 300: 1.120, 200: 1.200},
     'p95': {100: 1.283, 300: 1.899, 200: 1.899}, 'db': {100: 1.172, 300: 1.176, 200: 1.176},
     'thr': {100: 1.00004, 300: 1.00023, 200: 1.00023}}
ERR_SPREAD = 0.0029
C1 = {}
for r in (100, 200, 300):
    row = {}
    for m in ['cpu', 'p50', 'p95', 'thr', 'err', 'db']:
        ex = [e[m] for e in EXIST[r]]; v = med(2, r, m)
        if m == 'err': lo, hi = max(0, min(ex) - ERR_SPREAD), max(ex) + ERR_SPREAD
        else: lo, hi = min(ex) / B[m][r], max(ex) * B[m][r]
        row[m] = dict(median2x=v, existing=ex, range=[lo, hi], BASELINE_DRIFT=not (lo <= v <= hi))
    C1[r] = row

# ---- §7.2/7.3 delta ----
TOL = {'cpu': ('pct', 0.20), 'p50': ('x', 1.45), 'p95': ('x', 2.0), 'db': ('x', 1.38)}
def cat_ratio(cr, br, rho, Bd):
    if 1 / Bd <= rho <= Bd: return 'none'
    if rho > Bd and min(cr) > max(br): return 'up'
    if rho < 1 / Bd and max(cr) < min(br): return 'down'
    return 'indeterminate'
def cat_abs(cr, br, dlt, thr):
    if abs(dlt) <= thr: return 'none'
    if dlt > 0 and min(cr) > max(br): return 'up'
    if dlt < 0 and max(cr) < min(br): return 'down'
    return 'indeterminate'
def pcat(v, Bd=None, thr=None):
    if thr is not None: return 'none' if abs(v) <= thr else ('up' if v > 0 else 'down')
    return 'none' if 1 / Bd <= v <= Bd else ('up' if v > Bd else 'down')
DELTA = {}
for c in (1, 3):
    for r in (100, 200, 300):
        P, P2 = pred(c, r), pred(2, r)
        for m in ['cpu', 'p50', 'p95', 'db', 'goodputPct', 'err']:
            cr, br = reps(c, r, m), reps(2, r, m)
            pair = [R[(c, r, k)][m] for k in (1, 2, 3)], [R[(2, r, k)][m] for k in (1, 2, 3)]
            e = dict(cReps=cr, b2xReps=br)
            if m in ('goodputPct', 'err'):
                thr = 1.0 if m == 'goodputPct' else 0.01
                pv = (P['thr'] / r * 100 - P2['thr'] / r * 100) if m == 'goodputPct' else (P['err'] - P2['err'])
                dm = st.median(cr) - st.median(br)
                pd_ = [a - b for a, b in zip(*pair)]
                e.update(measDeltaPp=dm, predDeltaPp=pv, diffPp=pv - dm, measDir=cat_abs(cr, br, dm, thr), predDir=pcat(pv, thr=thr),
                         pass_=abs(pv - dm) <= thr, pairedDeltas=pd_, pairedMedian=st.median(pd_),
                         extremePair=[min(cr) - max(br), max(cr) - min(br)])
                pdir = 'none' if abs(st.median(pd_)) <= thr else ('up' if all(x > thr for x in pd_) else 'down' if all(x < -thr for x in pd_) else 'indeterminate')
            else:
                Bp = B[m][r]; Bc = max(br) / min(br); Bd = max(Bp, Bc)
                rm = st.median(cr) / st.median(br); rp = P[m] / P2[m]
                prs = [a / b for a, b in zip(*pair)]
                md = cat_ratio(cr, br, rm, Bd)
                e.update(Bprereg=Bp, Bcampaign2x=Bc, Bdetect=Bd, rhoMeas=rm, rhoPred=rp, pctMeas=(rm - 1) * 100, pctPred=(rp - 1) * 100,
                         diffPp=(rp - rm) * 100, measDir=md, predDir=pcat(rp, Bd), extremePair=[min(cr) / max(br), max(cr) / min(br)],
                         pairedRatios=prs, pairedMedian=st.median(prs))
                kind, T = TOL[m]
                if md in ('up', 'down'):
                    e['magnitudeOk'] = abs(rp / rm - 1) <= T if kind == 'pct' else (1 / T <= rp / rm <= T)
                else: e['magnitudeOk'] = None
                if m == 'cpu':
                    nr = NAIVE[(c, r)] / NAIVE[(2, r)]
                    e['naive'] = dict(rhoPred=nr, predDir=pcat(nr, Bd), dirOk=None if md == 'indeterminate' else pcat(nr, Bd) == md,
                                      magnitudeOk=(abs(nr / rm - 1) <= T) if md in ('up', 'down') else None)
                pm = st.median(prs)
                pdir = 'none' if 1 / Bd <= pm <= Bd else ('up' if all(x > Bd for x in prs) else 'down' if all(x < 1 / Bd for x in prs) else 'indeterminate')
            e['pairedDir'] = pdir
            e['sessionSensitive'] = pdir != e['measDir']
            e['dirOk'] = None if e['measDir'] == 'indeterminate' else e['predDir'] == e['measDir']
            DELTA[f'2to{c}|{r}|{m}'] = e

def verdict(c):
    fails, dir_fail, mag_fail = [], False, False
    for r in (100, 200, 300):
        for m in ['cpu', 'p95', 'goodputPct', 'err']:
            e = DELTA[f'2to{c}|{r}|{m}']
            if e['dirOk'] is False: dir_fail = True; fails.append(f'{r} {m} direction (meas {e["measDir"]}, pred {e["predDir"]})')
        e = DELTA[f'2to{c}|{r}|cpu']
        if e['magnitudeOk'] is not True: mag_fail = True; fails.append(f'{r} cpu magnitude ({"not judged: meas " + e["measDir"] if e["magnitudeOk"] is None else "outside ±20%"}; pred {e["pctPred"]:+.1f}% vs meas {e["pctMeas"]:+.1f}%)')
        for m in ['goodputPct', 'err']:
            e = DELTA[f'2to{c}|{r}|{m}']
            if not e['pass_']: mag_fail = True; fails.append(f'{r} {"C7 goodput" if m == "goodputPct" else "C8 errors"} (pred {e["predDeltaPp"]:+.4f} pp vs meas {e["measDeltaPp"]:+.4f} pp)')
    p95ok = sum(1 for r in (100, 200, 300) if DELTA[f'2to{c}|{r}|p95']['magnitudeOk'] is True)
    if p95ok < 2:
        mag_fail = True
        fails.append(f'P95 magnitude within ×/÷2 at {p95ok}/3 rungs (judged only where measured direction is up/down: ' +
                     ', '.join(f'{r}:{DELTA[f"2to{c}|{r}|p95"]["measDir"]}' for r in (100, 200, 300)) + ')')
    v = 'Does not predict the change' if dir_fail else ('Direction only' if mag_fail else 'CWM predicts the change')
    return dict(verdict=v, failing=fails, p95MagnitudeOkRungs=p95ok)
VERD = {'2to1': verdict(1), '2to3': verdict(3)}
def naive_c13(c):
    out = {}
    for r in (100, 200, 300):
        e = DELTA[f'2to{c}|{r}|cpu']; out[r] = dict(cwmRho=e['rhoPred'], naiveRho=e['naive']['rhoPred'], measRho=e['rhoMeas'],
                                                   measDir=e['measDir'], naiveDirOk=e['naive']['dirOk'], naiveMagOk=e['naive']['magnitudeOk'],
                                                   cwmDirOk=e['dirOk'], cwmMagOk=e['magnitudeOk'])
    return out
C13 = {'2to1': naive_c13(1), '2to3': naive_c13(3)}

# ---- §7.4 DR ----
DR = {}
for r in (100, 200, 300):
    g12 = med(1, r, 'p95') / med(2, r, 'p95'); g23 = med(2, r, 'p95') / med(3, r, 'p95')
    q12 = med(1, r, 'p50') / med(2, r, 'p50'); q23 = med(2, r, 'p50') / med(3, r, 'p50')
    pg12 = pred(1, r)['p95'] / pred(2, r)['p95']; pg23 = pred(2, r)['p95'] / pred(3, r)['p95']
    d21, d23 = DELTA[f'2to1|{r}|p95']['measDir'], DELTA[f'2to3|{r}|p95']['measDir']
    db21, db23 = DELTA[f'2to1|{r}|db']['measDir'], DELTA[f'2to3|{r}|db']['measDir']
    cond = [d21 == 'up', (d23 == 'none' or g23 < g12), db21 == 'none' and db23 == 'none']
    if all(cond): held = 'holds'
    elif 'indeterminate' in (d21, d23, db21, db23): held = 'indeterminate'
    else: held = 'does not hold'
    DR[r] = dict(gain12=g12, gain23=g23, p50gain12=q12, p50gain23=q23, predGain12=pg12, predGain23=pg23,
                 meas2to1P95=d21, meas2to3P95=d23, pred2to3P95=DELTA[f'2to3|{r}|p95']['predDir'], db2to1=db21, db2to3=db23,
                 measured=held, cwmCaptures=(pg23 < pg12) and DELTA[f'2to3|{r}|p95']['predDir'] == d23,
                 dbConnMaxMedian={n: med(n, r, 'dbConnMax') for n in (1, 2, 3)})

# ---- C12 ----
C12 = {}
for n in (1, 2, 3):
    for r in (100, 200, 300):
        C12[f'{n}x-{r}'] = dict(fleetBudget=n * 250, maxConnections=500, predErr=pred(n, r)['err'],
            predConnErrors=False, predWarnings=pred(n, r)['warnings'],
            reps=[dict(session=k, errorClasses=R[(n, r, k)]['errorClasses'], failed=R[(n, r, k)]['failed'],
                       dbConnMax=R[(n, r, k)]['dbConnMax'], dbConnAvg=R[(n, r, k)]['dbConnAvg'], spikeMinuteUtc=R[(n, r, k)]['dbConnSpikeMinuteUtc'],
                       minuteMin=R[(n, r, k)]['dbConnMinuteMin'], saturation=R[(n, r, k)]['dbConnSaturation'],
                       peakVUs=R[(n, r, k)]['peakVUs'], albElb5xx=R[(n, r, k)]['albElb5xx']) for k in (1, 2, 3)],
            tooManyConnections=sum(R[(n, r, k)]['errorClasses'].get('too_many_connections', 0) for k in (1, 2, 3)),
            queueFull=sum(R[(n, r, k)]['errorClasses'].get('queue_full', 0) for k in (1, 2, 3)))

RDSV = {a: dict(engineVersion=A['engineVersions'][0], autoMinorUpgrade=A['autoMinorUpgrade'][0], applyStartUtc=A['started'].get('startedAt') or A['started'])
        for a, A in APPLY.items()}
s12 = {RDSV[SESS[k][n]]['engineVersion'] for k in (1, 2) for n in (1, 2, 3)}
s3 = {RDSV[SESS[3][n]]['engineVersion'] for n in (1, 2, 3)}

res = dict(campaignId='typical-scale-v1-20261006', engine=PRED['engineVersion'], scoredAgainstCommit=SHA,
    predictionsFile='typical/scale-v1/predictions/predictions.json', calibrationUnchanged=PRED['calibrationId'], amiPinned=AMI,
    sessions={k: {f'{n}x': SESS[k][n] for n in (1, 2, 3)} for k in SESS},
    notes=['Cells scored on the per-metric median of 3 reps; per-rep totals min/max reported.',
           'meas.cost is the list-price reference (0.3585/0.4545/0.5505 by N), not a measured bill.',
           'No-egress cost prediction is derived (non-egress list-price lines), so its cost score is 100.',
           'rel, errs, W loaded unchanged from typical/after-fit/score_export.py.',
           'Goodput delta in pp of target RPS; error delta in pp of requests.',
           'C1 ranges: [min/R, max*R] with R = prereg band B; errors use [min-0.0029, max+0.0029] pp (B for errors is an absolute spread).'],
    integrity=dict(passed=not FAIL, failures=FAIL, rungs=len(R), applies=list(APPLY)),
    rdsEngineVersions=RDSV, rdsSameBuildAcrossSessions=(s12 == s3), rdsSessions12=sorted(s12), rdsSession3=sorted(s3),
    cells=scores, C1=C1, delta=DELTA, verdicts=VERD, C13=C13, C9=DR, C12=C12,
    rungs={f'{n}x-{r}-r{k}': {kk: v for kk, v in R[(n, r, k)].items()} for (n, r, k) in sorted(R)})
os.makedirs(DEST, exist_ok=True)
json.dump(res, open(f'{DEST}/scores-scale-v1-20261006.json', 'w'), indent=1, default=str)
cols = ['rung', 'scenario', 'session', 'apply', 'runId', 'rds', 'attempt', 'window_start', 'window_end', 'app_cpu_mean_pct', 'app_cpu_per_host',
        'db_cpu_pct', 'db_conn_max', 'db_conn_avg', 'db_conn_spike_minute_utc', 'k6_p50_ms', 'k6_p95_ms', 'k6_p99_ms', 'alb_p50_ms', 'alb_p95_ms', 'alb_p99_ms',
        'goodput_rps', 'k6_requests', 'k6_failed', 'error_rate_pct', 'error_classes', 'alb_elb_5xx', 'gen_cpu_avg_pct', 'gen_cpu_peak_pct', 'peak_vus',
        'burst_rds_min', 'burst_app_min', 'pred_cpu', 'pred_p50', 'pred_p95', 'pred_thr', 'pred_err', 'pred_db', 'rep_total_connector', 'rep_total_noegress', 'rep_no_cost']
with open(f'{DEST}/metrics.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(cols)
    for (n, r, k) in sorted(R):
        M = R[(n, r, k)]; P = pred(n, r)
        s1 = score(P, M, P['cost'], REFN[n]); s2 = score(P, M, REFN[n], REFN[n])
        w.writerow([f'{n}x-{r}-r{k}', M['scenario'], k, M['apply'], M['runId'], M['rds'], M['attempt'], M['window']['actualStartTime'], M['window']['actualEndTime'],
                    M['cpu'], ';'.join(f'{x:.3f}' for x in M['cpuPerHost']), M['db'], M['dbConnMax'], M['dbConnAvg'], M['dbConnSpikeMinuteUtc'],
                    M['p50'], M['p95'], M['p99'], M['albP50'], M['albP95'], M['albP99'], M['thr'], M['httpReqs'], M['failed'], M['err'],
                    ';'.join(f'{a}={b}' for a, b in M['errorClasses'].items()) or 'none', M['albElb5xx'], M['genCpuAvg'], M['genCpuPeak'], M['peakVUs'],
                    M['burstRds'], M['burstApp'], P['cpu'], P['p50'], P['p95'], P['thr'], P['err'], P['db'], s1[1], s2[1], s1[2]])
print('integrity', 'PASS' if not FAIL else 'FAIL', FAIL)
