# oci-holdout-v2 measurement pin

The measurement pin is
**`221aa668cf72f4569a9c3ceaf111258cf86c394f`**, the PR #73 merge commit on
`canvascloudai/cwm-bench` main, adapter **1.9.7**. **No apply is allowed until
this follow-up merges** and Kevin gives the single paid go.

Adapter 1.9.7 differs from the oci-holdout-v1 pin `17376407cd8107732f35ba45785a9a06e10849a3` (adapter 1.9.6) only in:

- the accepted apply-id form (`oci-holdout-v{1|2}-…`) in the adapter and in `terraform/oci/variables.tf`, plus a check that v2 apply-id stamps are `20261124` or later;
- the `campaign` tag, now derived from the apply id;
- the version number, tests and documentation.

Load scripts, parser, collect, cleanup, topology, timings and scoring code are unchanged. Never pool measurements from different pins.
