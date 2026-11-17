# oci-holdout-v1 measurement pin

The measurement pin for oci-holdout-v1 is the **merge commit of the
`fix/oci-mysql-password` pull request** (adapter 1.9.1: OCI MySQL
HeatWave admin-password constraints, on top of the 1.9.0 harness).

Kevin explicitly approved using that merge commit as the pin **without**
a follow-up edit to the frozen preregistration. `PREREGISTRATION.md` and
`freeze/` are unchanged. Do not invent the merge SHA here; after merge,
the pin is that commit on `main`. A branch name is not a pin.

Paid apply still requires Kevin's separate campaign go.
