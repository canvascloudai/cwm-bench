"""Build score.mjs evidence from the account-redacted archive (run from the extracted archive root).
Usage: python3 build_evidence.py out/attempt-r1initial-0 > evidence-r1.json"""
import json, re, sys
d = sys.argv[1].rstrip('/') + '/'
cv = json.load(open(d + 'campaign-validity.json'))
gv = json.dumps(json.load(open(d + 'wait-ready-show-global-variables.json')))
live = int(re.search(r'max_prepared_stmt_count[^0-9]{0,40}(\d+)', gv).group(1))
def err(x, n):
    return next((int(e['SUM_ERROR_RAISED']) for e in x.get('errors', []) if e['ERROR_NUMBER'] == n), 0)
samples = json.load(open(d + 'diagnostic-time-series.json'))['samples']
polls = [{'at': x['at'], 'threads': int(x['status']['Threads_connected']), 'prepared': int(x['status']['Prepared_stmt_count']),
          'e1461': err(x, 1461), 'e1040': err(x, 1040)} for x in samples]
rungs = [{'rps': r['rps'], 'startAt': r['startAt'], 'stopAt': r['stopAt'], 'forecast': r['forecast']} for r in cv['generatorBoundaries']]
json.dump({'preflight': {'liveParameter': live, 'inSync': cv['parameterGroupInSync'], 'harnessIntact': cv['intact']},
           'rungs': rungs, 'polls': polls, 'faults': []}, sys.stdout)
