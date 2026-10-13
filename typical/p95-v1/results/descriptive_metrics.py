#!/usr/bin/env python3
"""Descriptive per-rung metrics for typical-p95-v1. Not scoring. Steady P95 uses
score_p95_v1.py's own read_request_samples/steady_window/steady_only_p95."""
import sys, json, glob, os, csv, statistics
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import score_p95_v1 as S
OUT=sys.argv[1]  # tree with rungs/*/k6.json.gz
VALID=['typical-p95-1x-r1a-20261010','typical-p95-1x-r2-20261011','typical-p95-1x-r3-20261012',
 'typical-p95-2x-r1-20261010','typical-p95-2x-r2-20261011','typical-p95-2x-r3-20261012',
 'typical-p95-3x-r1-20261010','typical-p95-3x-r2-20261011','typical-p95-3x-r3-20261012']
def one(args):
    camp, scen = args
    d=f'{OUT}/{camp}'
    c=json.load(open(f'{d}/11-{scen}.collect.json'))
    sm=json.load(open(f'{d}/rungs/{scen}/summary.json'))['metrics']
    samples=S.read_request_samples(f'{d}/rungs/{scen}/k6.json.gz')
    w=S.steady_window(c)
    ts=[t for t,_ in samples if t]
    pn=c['perNode']
    app=[n['cpuAvgPct'] for n in pn if n['role']=='app']
    db=[n['cpuAvgPct'] for n in pn if n['role']=='database']
    rds=json.load(open(f'{d}/03-rds-engine-version.json'))['DBInstances'][0]['EngineVersion']
    fail=sm.get('http_req_failed',{}).get('values',{})
    reqs=sm.get('http_reqs',{}).get('values',{}).get('count')
    drop=sm.get('dropped_iterations',{}).get('values',{}).get('count',0)
    return dict(campaign=camp, scenario=scen, servers=int(scen.split('-')[2][0]), rps=int(scen.split('-')[3]),
      rung_pos=c.get('rung_pos'), sha=c['measurementSha'], adapter=c['adapterVersion'], ami=c['resolvedAmis']['amiId'],
      rds_version=rds, p95_ms=c['latency']['p95Ms'], p50_ms=c['latency']['p50Ms'], p99_ms=c['latency']['p99Ms'],
      untagged=c['latency']['untaggedAggregate'], steady_p95_ms=S.steady_only_p95(samples,w),
      n_samples=len(samples), http_reqs=reqs, error_rate=fail.get('rate'), errors=fail.get('passes'),
      error_categories=json.dumps(c.get('errorCategories')), dropped_iterations=drop,
      app_cpu_mean=statistics.mean(app) if app else None, db_cpu=db[0] if db else None,
      db_conn_max=c['databaseConnections']['max'], goodput_rps=c.get('goodputRps'),
      first_sample=min(ts).isoformat(), last_sample=max(ts).isoformat(),
      run_seconds=(max(ts)-min(ts)).total_seconds())
if __name__=='__main__':
    jobs=[(camp,f'typical-p95-{camp.split("-")[2]}-{r}') for camp in VALID for r in (300,200,100)]
    with Pool(3, maxtasksperchild=1) as p: rows=p.map(one,jobs,chunksize=1)
    with open(sys.argv[2]+'/metrics.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    json.dump(rows,open(sys.argv[2]+'/descriptive-rungs.json','w'),indent=1)
    print('done',len(rows))
