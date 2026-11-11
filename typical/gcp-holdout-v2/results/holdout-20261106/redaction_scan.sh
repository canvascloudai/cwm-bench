#!/usr/bin/env bash
# Usage: CWM_PRIVATE_PROJECT_RE='<project-id>' redaction_scan.sh <extracted-archive-root>
# Own redaction scan over every file in the extracted archive, decompressing gzip payloads.
set -u
ROOT="$1"
# The private project id is never committed; pass it (regex) at run time.
: "${CWM_PRIVATE_PROJECT_RE:?set CWM_PRIVATE_PROJECT_RE to the private project id}"
declare -A P=(
  [named_project_id]="$CWM_PRIVATE_PROJECT_RE"
  [projects_path_unredacted]='projects/[^[/"]'
  [billing_account]='\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b'
  [billingAccounts_path]='billingAccounts/[^[]'
  [sa_email]='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com'
  [any_email]='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}'
  [project_number_12d]='(^|[^0-9.])[0-9]{12}([^0-9.]|$)'
)
cd "$ROOT"
for k in "${!P[@]}"; do
  n_plain=$(find . -type f ! -name '*.gz' ! -name '*.recompute.json' -print0 | xargs -0 grep -EhoI -- "${P[$k]}" 2>/dev/null | wc -l)
  n_gz=0
  while IFS= read -r -d '' f; do
    c=$(zcat "$f" | LC_ALL=C grep -Eo -- "${P[$k]}" | wc -l); n_gz=$((n_gz + c))
  done < <(find . -type f -name '*.gz' -print0)
  echo "$k plain=$n_plain gz=$n_gz"
done
