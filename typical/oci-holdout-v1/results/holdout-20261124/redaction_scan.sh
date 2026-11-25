#!/usr/bin/env bash
# Privacy scan for oci-holdout-v1 results and the redacted archive.
# Usage: ./redaction_scan.sh [dir]   (default: this directory). Searches gzip payloads too.
# Exit 1 if any identifier pattern matches.
set -u
DIR="${1:-$(dirname "$0")}"
fail=0
check() {
  local label="$1" pat="$2"
  local hits
  hits=$(rg -z -P -l --no-messages -g '!redaction_scan.sh' "$pat" "$DIR" || true)
  if [ -n "$hits" ]; then echo "FAIL $label"; echo "$hits"; fail=1; else echo "ok   $label"; fi
}
check "OCI OCID"            'ocid1\.'
check "PEM block"           'BEGIN [A-Z ]*(PRIVATE KEY|PUBLIC KEY|CERTIFICATE|KEY)'
check "SSH key"             'ssh-(rsa|ed25519|dss) [A-Za-z0-9+/]|ecdsa-sha2-'
check "key fingerprint"     '\b([0-9a-f]{2}:){15}[0-9a-f]{2}\b'
check "IPv4 address"        '\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b'
check "Terraform state/plan, user_data, known_hosts" 'terraform\.tfstate|"user_data"|known_hosts|tfplan'
check "foreign project id"  'favorable-fold'
check "tenancy/user field"  '"(tenancy|user|fingerprint|key_file|private_key)"\s*:'
exit $fail
