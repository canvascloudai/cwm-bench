#!/usr/bin/env bash
# Cleanup-only Terraform destroy with bounded retries.
#
# RDS deletion is eventually consistent. The instance can still hold a
# subnet group, security group, or RDS-managed ENI after terraform has
# moved on. Those ENIs are AWS-managed: do not DetachNetworkInterface
# and do not expand IAM. Wait for RDS to release them, then retry.
#
# Success means the stack was destroyed. This is not a campaign result
# and must not be reported as "campaign complete".
#
# An interrupted apply should default to cleanup, not resume
# measurement. The Admin Benchmarks worker owns that policy.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/terraform-destroy-retry.sh [terraform destroy args...]

Cleanup only. Runs terraform init -reconfigure, then destroy. On
subnet-group / ENI / SG still-in-use failures, refreshes state, waits
with bounded backoff, and retries until RDS is gone or the deadline
is hit.

Example:
  ./scripts/terraform-destroy-retry.sh -var='test_id=YYYYMMDD-campaign' -auto-approve

Environment:
  CWM_TF_DIR                     Terraform directory (default: <repo>/terraform)
  CWM_DESTROY_MAX_ATTEMPTS       Max destroy attempts (default: 12)
  CWM_DESTROY_SLEEP_SECONDS      Initial backoff seconds (default: 20)
  CWM_DESTROY_MAX_SLEEP_SECONDS  Cap on backoff seconds (default: 120)
  CWM_DESTROY_DEADLINE_SECONDS   Overall deadline (default: 3600)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="${CWM_TF_DIR:-$ROOT/terraform}"
MAX_ATTEMPTS="${CWM_DESTROY_MAX_ATTEMPTS:-12}"
SLEEP_SECONDS="${CWM_DESTROY_SLEEP_SECONDS:-20}"
MAX_SLEEP="${CWM_DESTROY_MAX_SLEEP_SECONDS:-120}"
DEADLINE_SECONDS="${CWM_DESTROY_DEADLINE_SECONDS:-3600}"
STARTED_AT="$(date +%s)"

if [[ ! -d "$TF_DIR" ]]; then
  echo "terraform directory not found: $TF_DIR" >&2
  exit 1
fi

is_retryable() {
  local text="$1"
  # RDS still deleting / DependencyViolation on subnet group, SG, ENI.
  # AccessDenied on DetachNetworkInterface is the same race: wait, do not
  # add that permission.
  grep -Eiq \
    'DependencyViolation|ResourceInUse|InvalidDBSubnetGroupState|InvalidDBInstanceState|still in use|currently in use|has a dependent object|has dependencies|NetworkInterface|network interface|DetachNetworkInterface|cannot be deleted because it is in use' \
    <<<"$text"
}

# refresh accepts -var / -var-file, not destroy-only flags.
collect_refresh_args() {
  REFRESH_ARGS=()
  local arg
  for arg in "$@"; do
    case "$arg" in
      -auto-approve|--auto-approve|-auto-approve=*) ;;
      *) REFRESH_ARGS+=("$arg") ;;
    esac
  done
}

elapsed() {
  echo $(( $(date +%s) - STARTED_AT ))
}

past_deadline() {
  [[ "$(elapsed)" -ge "$DEADLINE_SECONDS" ]]
}

echo "cwm-bench cleanup: terraform destroy with bounded retries" >&2
echo "directory=$TF_DIR attempts=$MAX_ATTEMPTS deadline=${DEADLINE_SECONDS}s" >&2

terraform -chdir="$TF_DIR" init -reconfigure -input=false

attempt=1
sleep_for="$SLEEP_SECONDS"
while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
  if past_deadline; then
    echo "cwm-bench cleanup: deadline reached after $(elapsed)s; destroy incomplete" >&2
    exit 1
  fi

  echo "cwm-bench cleanup: destroy attempt ${attempt}/${MAX_ATTEMPTS}" >&2
  destroy_log="$(mktemp)"
  set +e
  terraform -chdir="$TF_DIR" destroy -input=false "$@" >"$destroy_log" 2>&1
  status=$?
  set -e
  output="$(cat "$destroy_log")"
  cat "$destroy_log" >&2
  rm -f "$destroy_log"

  if [[ "$status" -eq 0 ]]; then
    echo "cwm-bench cleanup: destroy finished (stack removed; not a campaign result)" >&2
    exit 0
  fi

  if ! is_retryable "$output"; then
    echo "cwm-bench cleanup: destroy failed with a non-retryable error" >&2
    exit "$status"
  fi

  if [[ "$attempt" -eq "$MAX_ATTEMPTS" ]] || past_deadline; then
    echo "cwm-bench cleanup: retry budget exhausted; RDS path may still be deleting" >&2
    exit "$status"
  fi

  echo "cwm-bench cleanup: retryable subnet-group / ENI / SG race; waiting ${sleep_for}s then refresh" >&2
  sleep "$sleep_for"
  # Refresh lets state observe RDS finishing deletion without inventing a detach.
  collect_refresh_args "$@"
  set +e
  terraform -chdir="$TF_DIR" refresh -input=false "${REFRESH_ARGS[@]}" >/dev/null
  set -e

  if [[ "$sleep_for" -lt "$MAX_SLEEP" ]]; then
    sleep_for=$((sleep_for * 2))
    if [[ "$sleep_for" -gt "$MAX_SLEEP" ]]; then
      sleep_for="$MAX_SLEEP"
    fi
  fi
  attempt=$((attempt + 1))
done

echo "cwm-bench cleanup: destroy incomplete" >&2
exit 1
