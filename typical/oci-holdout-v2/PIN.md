# oci-holdout-v2 measurement pin

The measurement pin is
**`9141f808bf545481f0a3621739cc4b93c6908074`**, the PR #75 bootstrap-hardening
merge commit on `canvascloudai/cwm-bench` main, adapter **1.9.7**.
This PIN follow-up must merge before paid v2 r1/r2, followed by the owner's
separate paid go. A separately approved operational rehearsal is not a v2
repetition and must never be scored or archived as holdout evidence.

The original v2 pin was `221aa668cf72f4569a9c3ceaf111258cf86c394f`.
The new pin adds only the bootstrap hardening described in
[PREREG.md](PREREG.md): DNS wait, Ksplice repo exclusion, offline firewall
configuration, bounded timeouts and private command tracing, plus bootstrap
tests and that operational amendment. Adapter remains 1.9.7.

Relative to the oci-holdout-v1 pin
`17376407cd8107732f35ba45785a9a06e10849a3` (adapter 1.9.6), the original v2
changes remain:

- accepted apply-id forms in the adapter and Terraform, with v2 dates at or
  after `20261124`;
- campaign tag derived from the apply id;
- adapter version, tests and documentation.

Topology, load ladder, timings, measurement, collection, cleanup and scoring
are unchanged. Never pool measurements from different pins or reuse rehearsal
data as holdout evidence.
