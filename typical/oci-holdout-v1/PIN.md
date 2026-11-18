# oci-holdout-v1 measurement pin

The approved measurement pin is **`783896c3b229d76bcd594aad06fd6c9f5f70de74`**,
the PR #68 merge commit on `canvascloudai/cwm-bench` main, adapter **1.9.4**.
It supersedes **`6577427d4ad48bd02137824282592ccf8a50611e`** (PR #67,
adapter 1.9.3). A branch name is not a pin.

The superseded attempts failed before workload dispatch. No measurements
from them are accepted or pooled. Adapter 1.9.4 corrects the OCI MySQL
storage-response field and local SSH-key cleanup compatibility, and
recognizes successful empty backup-list output without treating API
errors as zero backups.

Kevin explicitly approved this exact pin and a new paid go: r1 starts
with a fresh initial apply plus up to three replacement applies under
the standing-approvals table. That approval also covers r2, its allowed
replacements, and all cleanup. Run r2 automatically at least 12 hours
after r1 ends, on a different America/New_York day and UTC day.

Kevin explicitly authorized execution without waiting for this PIN.md
follow-up to merge. Record that authorization, the verified source SHA,
the exact selected MySQL 8.x version, and the actual executed controller
SHA-256 in the evidence. Never substitute an earlier controller hash.

`PREREGISTRATION.md`, `freeze/`, load scripts, topology, timing, and
scoring are unchanged. Never pool measurements from different pins.
Keep private host keys, Terraform state, plans, user_data, known_hosts,
and SSH public keys (including ssh-ed25519) out of evidence archives.
