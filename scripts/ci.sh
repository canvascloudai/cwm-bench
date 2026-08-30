#!/usr/bin/env bash
# cwm-bench CI — honesty first.
#
# 1. Never optimize the composite accuracy score.
# 2. Fit per-metric only on a declared fit split.
# 3. Hold out Burst, a later day, and a second region.
# 4. A coefficients change without a new measurement ID is rejected.
# 5. Until v1 measurements exist: keep Burst visible as a known gap.
#    Do not label latency/CPU/throughput/error as "measured".
# 6. BurstBalance=0 is a third error bucket (iops_throttle).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> honesty: results/ must not claim isExample=false"
python3 scripts/check_results_honesty.py

echo "==> honesty: coefficients provenance"
python3 -m pip install -q -r calibrate/requirements.txt
python3 calibrate/calibrate.py --check-provenance

echo "==> calibrate stub (no measurements yet)"
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
  else
    # Older k6 builds may lack inspect; archive still parses init.
    k6 archive load/scenarios.js -O /tmp/cwm-scenarios.tar >/dev/null
    k6 archive load/diagnostics.js -O /tmp/cwm-diagnostics.tar >/dev/null
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

echo "CI passed"
