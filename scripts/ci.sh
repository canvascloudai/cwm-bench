#!/usr/bin/env bash
# cwm-bench CI — honesty first.
#
# 1. Never optimize the composite accuracy score.
# 2. Fit per-metric only on a declared fit split.
# 3. Hold out Burst, a later day, and a second region.
# 4. A coefficients change without a new measurement ID is rejected.
# 5. v1 owned holdout measurements are fitted per-metric on idle/normal/peak.
#    Do not invent CloudWatch or copy the public 2%/9.55% cell as owned.
# 6. BurstBalance=0 is a third error bucket (iops_throttle).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> honesty: results/ must not claim isExample=false"
python3 scripts/check_results_honesty.py

echo "==> typical after-fit score reproduction"
python3 typical/after-fit/score_export.py
python3 - << 'PY'
import json
from pathlib import Path

repro = json.loads(Path("typical/after-fit/scores-reproduced.json").read_text())
pub = json.loads(Path("typical/scores-after-fit.json").read_text())
for rung in ("20", "100", "200", "300", "500"):
    scored = repro[rung]["connectorCostBasis"]
    published = pub[rung]
    if scored["scores"] != published["scores"] or scored["total"] != published["total"] or scored["withoutCost"] != published["noCost"]:
        raise SystemExit(f"after-fit scores diverge at {rung} RPS")
    predicted = repro[rung]["predicted"]
    for key in ("cpu", "p50", "p95", "p99", "thr", "err", "cost"):
        if predicted[key] != published["pred"][key]:
            raise SystemExit(f"after-fit prediction diverges at {rung} RPS {key}")
page = pub["300_pageCostBasis"]
no_egress = repro["300"]["noEgressCostBasis"]
if no_egress["scores"] != page["scores"] or no_egress["total"] != 84.2 or no_egress["withoutCost"] != 82.4:
    raise SystemExit("after-fit no-egress basis diverges")
if repro["300"]["connectorCostBasis"]["total"] != 74.8:
    raise SystemExit("after-fit connector total diverges")
print("after-fit export matches typical/scores-after-fit.json (84.2 / 74.8 / 82.4)")
PY

echo "==> honesty: coefficients provenance"
python3 -m pip install -q -r calibrate/requirements.txt
python3 calibrate/calibrate.py --check-provenance

echo "==> holdout + calibrate provenance tests"
python3 -m unittest discover -s tests -p 'test_*.py'

echo "==> calibrate per-metric OLS (fit_input; coefficients must match)"
python3 calibrate/calibrate.py
# Composite score must be refused.
set +e
python3 calibrate/calibrate.py --composite-score
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "calibrate accepted --composite-score; honesty violation" >&2
  exit 1
fi

echo "==> schema EXAMPLE fixtures"
python3 scripts/validate_schema.py

echo "==> app syntax (Node)"
if command -v node >/dev/null 2>&1; then
  (cd app && npm ci --ignore-scripts && npm run check)
  echo "==> app-typical syntax (Node)"
  (cd app-typical && npm ci --omit=dev --ignore-scripts && npm run check)
else
  echo "node not installed; skip app syntax" >&2
fi

echo "==> worker adapter unit tests (AWS mocked)"
if command -v node >/dev/null 2>&1; then
  node --test tests/adapter/*.test.mjs
else
  echo "node not installed; skip adapter tests" >&2
  exit 1
fi

echo "==> k6 script syntax"
if command -v k6 >/dev/null 2>&1; then
  export TARGET="${TARGET:-http://cwm-bench.example.invalid}"
  if k6 inspect load/scenarios.js >/dev/null 2>&1; then
    k6 inspect load/diagnostics.js >/dev/null
    k6 inspect load/typical.js >/dev/null
  else
    # Older k6 builds may lack inspect; archive still parses init.
    k6 archive load/scenarios.js -O /tmp/cwm-scenarios.tar >/dev/null
    k6 archive load/diagnostics.js -O /tmp/cwm-diagnostics.tar >/dev/null
    k6 archive load/typical.js -O /tmp/cwm-typical.tar >/dev/null
  fi
else
  echo "k6 not installed; skip k6 inspect" >&2
fi

echo "==> terraform fmt/validate (no apply)"
if command -v terraform >/dev/null 2>&1; then
  terraform -chdir=terraform fmt -check -recursive
  terraform -chdir=terraform init -backend=false -input=false
  terraform -chdir=terraform validate
else
  echo "terraform not installed; skip terraform" >&2
  exit 1
fi

echo "==> app-typical correctness against MySQL 8.0 (docker, if available)"
if { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; } \
  || { command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; }; then
  node tests/typical/correctness.mjs
else
  echo "docker unavailable; skip app-typical mysql correctness" >&2
fi

echo "CI passed"
