# oci-holdout-v1 measurement pin

The measurement pin for oci-holdout-v1 is the **merge commit of the
`fix/oci-mysql-8x` pull request** (adapter 1.9.2: require and resolve a
MySQL 8.x `mysql_version` before apply). That merge commit **supersedes
`72ede655`** (adapter 1.9.1).

`72ede655` remains the password-constraint fix, but the r1 replacement
on that commit was a **pre-rung harness fault**: `terraform/oci` did not
set `mysql_version`, OCI defaulted to a non-8 release, and the existing
8.x postcondition failed. No load ran and **no measurements were taken**,
so those attempts are not pooled and a new pin is required.

Kevin's earlier explicit approval to pin without editing the frozen
preregistration still applies. `PREREGISTRATION.md` and `freeze/` are
unchanged. Do not invent this pull request's merge SHA here; after
merge, the pin is that commit on `main`. A branch name is not a pin.

Paid apply still requires Kevin's separate campaign go.
