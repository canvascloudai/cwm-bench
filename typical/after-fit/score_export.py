"""Reproduce the after-fit typical scores from the frozen export files only.
Scoring rules are copied unchanged from results-2026-09-27/score.py
(weights, relative accuracy, error-rate rule). Run: python3 score_export.py"""
import json, sys, os
H = os.path.dirname(os.path.abspath(__file__))
W = dict(p50=.20, p95=.25, cpu=.20, thr=.15, err=.10, cost=.10)
def rel(s, r): return 100.0 if r == 0 else max(0, 100 - abs(s - r) / abs(r) * 100)
def errs(s, r):
    d = abs(s - r); ra = 0 if r == 0 else rel(s, r)
    return 100.0 if d <= 0.01 else max(100 * 0.01 / d, ra)
meas = json.load(open(f'{H}/measured-values.json'))['rungs']
costs = json.load(open(f'{H}/cost-references.json'))
REF = costs['listPriceReferenceNoEgress']['usdPerHour']            # 0.4545
def pred_from(rps, run='A'):
    m = json.load(open(f'{H}/raw/rung{rps}-run{run}-metrics.json'))
    app = [x['cpuPercent'] for x in m['resources'] if x['id'].startswith('app')]
    return dict(cpu=sum(app) / len(app), p50=m['latencyP50'], p95=m['latencyP95'], p99=m['latencyP99'],
                thr=m['throughput'], err=m['errorRate'], cost=m['costPerHour'],
                kind=m['calibrationEvidence']['kind'], engine=m['engineVersion'])
def score(p, M, cost_pred):
    mm = dict(cpu=M['appCpuPct'], p50=M['p50Ms'], p95=M['p95Ms'], thr=M['goodputRps'], err=M['errorRatePct'])
    sc = {k: round(rel(p[k], mm[k]), 1) for k in ['p50', 'p95', 'cpu', 'thr']}
    sc['err'] = round(errs(p['err'], mm['err']), 1)
    sc['cost'] = round(rel(cost_pred, REF), 1)
    tot = round(sum(W[k] * sc[k] for k in W), 1)
    noc = round(sum(W[k] * sc[k] for k in W if k != 'cost') / 0.9, 1)
    return sc, tot, noc
out = {}
for rps in ['20', '100', '200', '300', '500']:
    pA, pB = pred_from(rps, 'A'), pred_from(rps, 'B')
    assert pA == pB, f'run A and run B differ at {rps} RPS'
    M = meas[rps]
    sc, tot, noc = score(pA, M, pA['cost'])
    row = dict(role=M['role'], calibration=pA['kind'], engine=pA['engine'], predicted=pA,
               connectorCostBasis=dict(costPred=pA['cost'], scores=sc, total=tot, withoutCost=noc),
               p99DiagnosticScore=round(rel(pA['p99'], M['p99Ms']), 1))
    if rps == '300':
        nb = costs['scoredCostPredictionNoEgressBasis']['usdPerHour']   # 0.4545 = 0.879919 - 0.425419
        sc2, tot2, noc2 = score(pA, M, nb)
        row['noEgressCostBasis'] = dict(costPred=nb, scores=sc2, total=tot2, withoutCost=noc2)
    out[rps] = row
    print(f"{rps:>3} RPS [{M['role']}; {pA['kind']}] connector cost {pA['cost']}: total {tot}, without cost {noc}  {sc}")
h = out['300']
print('\n300 RPS independent holdout, after fit (engine %s):' % h['engine'])
print('  no-egress cost basis (0.4545 USD/hour):  total %.1f' % h['noEgressCostBasis']['total'])
print('  connector cost basis (0.88 USD/hour):    total %.1f' % h['connectorCostBasis']['total'])
print('  without cost (either basis):             %.1f' % h['connectorCostBasis']['withoutCost'])
exp = (84.2, 74.8, 82.4)
got = (h['noEgressCostBasis']['total'], h['connectorCostBasis']['total'], h['connectorCostBasis']['withoutCost'])
json.dump(out, open(f'{H}/scores-reproduced.json', 'w'), indent=1)
print('  matches expected 84.2 / 74.8 / 82.4:', got == exp)
sys.exit(0 if got == exp else 1)
