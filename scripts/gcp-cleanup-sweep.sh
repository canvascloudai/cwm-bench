#!/usr/bin/env bash
# GCP leftover sweep. Cleanup only. This is not a campaign result.
#
# Run once immediately after terraform destroy, and again 24 hours later.
# The script lists resources still labeled with CWM_TEST_ID. It does not
# delete anything by hand.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/gcp-cleanup-sweep.sh

Cleanup only. Lists Compute Engine instances, Cloud SQL instances, and
global forwarding rules labeled test_id=$CWM_TEST_ID. Not a campaign result.

Environment (required, never commit the values):
  GOOGLE_CLOUD_PROJECT     Project id
  CLOUDSDK_COMPUTE_REGION  Region (gcp-fit-v1 uses us-central1)
  CWM_TEST_ID              Apply id / label value

A second sweep 24 hours later is part of gcp-fit-v1. This script does
not sleep for 24 hours and does not decide the campaign.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

: "${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}"
: "${CLOUDSDK_COMPUTE_REGION:?set CLOUDSDK_COMPUTE_REGION}"
: "${CWM_TEST_ID:?set CWM_TEST_ID}"

if ! [[ "$CWM_TEST_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "CWM_TEST_ID is not a GCP label value" >&2
  exit 2
fi

echo "gcp-cleanup-sweep: cleanup only, not a campaign result" >&2

gcloud compute instances list \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --filter="labels.test_id=${CWM_TEST_ID}" \
  --format=json
gcloud sql instances list \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --filter="labels.test_id=${CWM_TEST_ID}" \
  --format=json
gcloud compute forwarding-rules list \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --global \
  --filter="labels.test_id=${CWM_TEST_ID}" \
  --format=json
gcloud compute networks list \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --filter="name~^cwm-bench-" \
  --format=json
