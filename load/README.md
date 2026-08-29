# Load scripts (k6)

Pinned on the generator by terraform: **k6 v0.54.0** (`var.k6_version`).

## Layout

| File | Purpose |
| --- | --- |
| `scenarios.js` | Canonical rungs: idle 10 / normal 100 / peak 500 / burst 1000 RPS. |
| `diagnostics.js` | Three 1000 RPS runs: pool-bound, app-bound, cpu-only. |
| `lib/common.js` | Arrival-rate options, error-class tagging, results path. |

Protocol for every script: **warmup then 15 min steady**. Defaults: `WARMUP=5m`, `DURATION=15m`. Override with env vars. VUs are pre-allocated from the target RPS (see `vuBudget`).

Request mix for `scenarios.js` and the mix diagnostics: **70% GET product, 20% list, 10% write**.

Results convention (never overwrite; one campaign per directory):

```
results/raw/{campaign_id}/{run_id}/
  summary.json          # k6 handleSummary
  k6.json               # --out json (optional, large)
  k6.csv                # --out csv (optional)
```

k6 writes `summary.json` via `handleSummary`. JSON/CSV archives need `--out` as below.

## Copy onto the generator

After `terraform apply`, SSM Session Manager (or SSH if you set `key_name`):

```bash
# On your laptop, from the repo root:
TEST_ID=...   # same as terraform -var=test_id
GEN_ID=$(terraform -chdir=terraform output -raw generator_instance_id)
REGION=$(terraform -chdir=terraform output -raw topology_declaration | python3 -c 'import json,sys; print(json.load(sys.stdin)["region"])')

# Option A: scripts are already on the instance at /opt/cwm-bench/load
#           (embedded by user_data; refreshed if app_source_git_ref was set).

# Option B: copy this tree
tar czf /tmp/cwm-load.tgz load
aws ssm start-session --target "$GEN_ID" --region "$REGION"
# then on the instance:
#   (upload via scp or SSM send-command)
```

Or, if `app_source_git_ref` was the campaign SHA, `/opt/cwm-bench/load` already matches that SHA.

## Invoke

Source the ALB target written by user_data:

```bash
sudo -i
source /opt/cwm-bench/TARGET.env
cd /opt/cwm-bench

export CAMPAIGN_ID="2026xxxx-v1"   # your id; do not invent a completed campaign
export RUN_ID="idle-1"
export SPLIT="fit"                 # or holdout
export WARMUP="5m"
export DURATION="15m"
export RESULTS_DIR="results/raw/${CAMPAIGN_ID}/${RUN_ID}"
mkdir -p "$RESULTS_DIR"

# Canonical rungs
SCENARIO=idle    k6 run --out json="$RESULTS_DIR/k6.json" --out csv="$RESULTS_DIR/k6.csv" load/scenarios.js
SCENARIO=normal  k6 run --out json="$RESULTS_DIR/k6.json" --out csv="$RESULTS_DIR/k6.csv" load/scenarios.js
SCENARIO=peak    k6 run --out json="$RESULTS_DIR/k6.json" --out csv="$RESULTS_DIR/k6.csv" load/scenarios.js
SCENARIO=burst   k6 run --out json="$RESULTS_DIR/k6.json" --out csv="$RESULTS_DIR/k6.csv" load/scenarios.js
```

Diagnostics at 1000 RPS (Burst holdout). **Re-apply** terraform before app-bound so the nodes actually have `APP_POOL_SIZE=40`.

```bash
# Expects APP_POOL_SIZE=250 on both app nodes (terraform default).
DIAGNOSTIC=pool-bound k6 run load/diagnostics.js

# Expects APP_POOL_SIZE=40. This is a different apply. Do not pretend
# the default 250-pool topology produced this run.
DIAGNOSTIC=app-bound  k6 run load/diagnostics.js

# CPU path only. No MySQL on the request.
DIAGNOSTIC=cpu-only CPU_SPIN_MS=20 k6 run load/diagnostics.js
```

Copy `results/raw/...` off the instance into this repo's `results/raw/` (never overwrite). Fill a schema-valid run document from k6 plus CloudWatch. Do not label latency / CPU / throughput / error as "measured" in product copy until that document exists.

## Error classes

When the app returns `{"error":{"class":"..."}}`, k6 increments `errors_by_class` with tag `error_class`. Possible values from the app: `db_timeout`, `too_many_connections`, `queue_full`, `cpu_overload`, `internal`. HTTP failures without a class are `unclassified`.

`iops_throttle` is **not** a k6 tag. Derive it from CloudWatch `BurstBalance` min = 0.

## What these diagnostics classify

The three 1000 RPS runs exist to **classify** saturation at Burst:

| Diagnostic | App pool | Request path | If this run sheds errors and the others do not |
| --- | --- | --- | --- |
| pool-bound | 250 | CRUD mix | Sessions toward the declared 500 cap are implicated |
| app-bound | 40 | CRUD mix | The application pool / queue is implicated |
| cpu-only | n/a | `/api/cpu-spin` | Userspace CPU on the app nodes is implicated |

None of those implications is a root-cause statement about the public CWM Burst cell (reference 2.00% vs simulated 9.55%). That cell is a **known gap** until a v1 campaign is written here. Do not assert a cause in comments, coefficients, or the accuracy page.

If app or RDS `BurstBalance` hits 0, that is a third bucket (`iops_throttle`), recorded even if k6 classes look like timeouts.
