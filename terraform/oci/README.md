# OCI holdout harness (implementation, not execution authority)

The frozen authority is `typical/oci-holdout-v1/PREREGISTRATION.md`, then
`typical/gcp-holdout-v2/PREREGISTRATION.md` for uncovered ambiguities. Neither
file, any freeze/load byte, prediction nor scorer is changed by this harness.

**Do not apply on the preregistration base or on an unmerged harness revision.**
First merge the harness, then merge the follow-up that fills the measurement
pin with the real harness merge commit, then obtain Kevin's separate paid go.
Nothing in these scripts grants that approval or automatically provisions,
changes quota, chooses replacements, schedules campaigns or deletes resources.
The preregistered external runner retains those responsibilities.

## Runtime-only inputs and isolation

Use a private per-apply working copy of this module and local state, a private
complete `runtime.tfvars.json`, and a private adapter state path. Supply every
variable in `variables.tf`; there are no account/image/AD defaults. Resolve the
owner's saved connection with its existing user-bound decrypt/fallback loader.
Do not use another owner's OCI row or unrelated workspace credentials.

The module reads the target compartment and requires its name to be
`cwm-bench-oci`. Region is fixed to `us-ashburn-1`. The AD suffix must agree with
the strict apply id. App, generator and MySQL share that AD. Choose only the
approved E4-compatible Oracle Linux 8 image, record its exact version privately,
and rotate ADs only under the frozen stockout rules, never by substituting shape.

Terraform provider authentication uses a private OCI config or standard
`OCI_TENANCY_OCID`, `OCI_USER_OCID`, `OCI_FINGERPRINT`, `OCI_PRIVATE_KEY_PATH`.
No credential belongs in command arguments, logs, the repository, or archives.
Plan/state, TF variables, cleanup manifests and complete Terraform outputs are
**private**, even when Terraform marks an output sensitive: `output -json`
intentionally returns cleartext. Do not archive them.

The controller needs compartment-scoped manage permission for the exact
network/compute/LB/MySQL resources in this module and inspect/read for
compartments, images, shapes, monitoring, resource search, backups and cost
reports. Budgets require tenancy-scope budget management with a compartment
target. No IAM policies or API keys are created by this module. VMs receive no
cloud credential or instance-principal policy. App HTTP is accessible only
from the LB subnet; DB 3306 only from the node subnet; SSH only from the
controller's /32; the DB has no public IP. Bootstrap HTTPS and monitoring-agent
egress are permitted. Oracle Linux's host firewall is opened for app HTTP.

The budget is monthly, targets only the named compartment, and has ACTUAL /
ABSOLUTE USD 15 and 25 email alerts. OCI budget alerts have no action hook here.
They never stop, destroy or mark a campaign failed.

## MySQL / HeatWave capability

Validated against real `oracle/oci` 7.32.0 schema (lock file included), and the
live read-only shape/configuration APIs. This is standalone paid `MySQL.2`,
not Autonomous Database and not an Always Free substitute.

The provider's `is_heat_wave_cluster_attached` is **computed only**. There is
no supported `heatwave_enabled=false` create argument. Explicit exclusion is
implemented by having **no** HeatWave-cluster resource/AddHeatWaveCluster call,
an applied Terraform postcondition requiring attachment false, and a live
pre-workload DB-system read requiring false. This is deliberate, not reliance
on an undocumented provider default.

The custom shape configuration requests max_connections=1000. A plan is **not**
an applied-value verification. Bootstrap SQL readback fails unless it is 1000;
before each future workload the controller reads both the applied configuration
and `@@GLOBAL.max_connections` / `@@version` from both nodes' DB connections.
That SQL result and exact Node/MySQL/k6 versions are recorded in run evidence.
HA, PITR, automatic backups, auto-expand storage and deletion protection are
off. Automatic backups delete with the system; final backup is explicitly
`SKIP_FINAL_BACKUP`. MySQL must remain 8.x, Node 20, k6 exactly v0.54.0.

## Adapter

Install OCI CLI, OpenSSH, Node 20+ and Terraform on the trusted controller.
Set `CWM_CLOUD=oci`, `CWM_TERRAFORM_DIR` to this apply's module working directory,
and `CWM_ADAPTER_STATE` to its private state file. Provide
`CWM_OCI_SSH_KEY` and `CWM_OCI_KNOWN_HOSTS` as private file paths. The known-hosts
file must be independently verified by the controller; this harness never
disables host-key verification or silently trusts an SSH key scan.

`CWM_CAMPAIGN_ID`, `CWM_RUN_ID`, `CWM_SCENARIO` identify every dispatch.
Optional `CWM_MEASUREMENT_SHA` must match Terraform. Run/collect keys are
`oci-holdout-10`, `oci-holdout-100`, `oci-holdout-500`, `oci-holdout-1000`.
The usual adapter CLI dispatches them to OCI only. `wait-ready` and `teardown`
use `CWM_CLOUD=oci`; teardown deliberately does **not** kill a detached rung.

Only 300s warmup / 900s steady are accepted. The same-apply fingerprint binds
resource identities and measurement SHA. A local exclusive controller lock
prevents concurrent run mutations; after an abrupt controller death, inspect
ownership before removing its stale lock. Pending identity permits reconnect
to the **same** run only, never dispatching the rung twice. Its atomic remote
directory and systemd unit are an additional run-once guard.

k6 runs under a detached systemd supervisor. The marker is atomically written
after exit and gzip completion. SSH drops retry with exponential backoff
bounded to about ten minutes, without any signal to k6. Status polling has an
overall 30-minute bound. A missing generator, nonzero k6 exit, corrupt or
unrecoverable raw samples, identity/hash change or required monitoring failure
faults the whole apply. Saturation/HTTP errors are measurements, never a reason
to repeat a rung. Retry-only controller launcher fixes remain outside this repo.

## Measurement and billing

`oci-raw.py` reads all request-level k6 samples, validates request streams and
identity, reconciles whole-run counts against the independent k6 summary, and
hashes both the compressed bytes and summary. Steady samples require both
phase=steady and the recorded launch UTC + [300,1200) seconds; this excludes
warmup's graceful-stop completions. Whole-run evidence includes ramp and the
completion tail until the recorded generator end. Boundary source is the
generator supervisor immediately before k6 invocation, not the controller's
clock or a trailing collection fallback. Request completions / 900 give steady
throughput; exact nearest-rank raw duration values give P50/P95/P99.

Total loss denominator = completed attempts + dropped iterations. Mutually
exclusive request classes distinguish 2xx success, non-2xx, timeout, reset,
refused and other transport failure; status zero / transport codes can never
count as success. Loss adds drops exactly once. HTTP status counts are also
retained. `http_req_failed` has its own independent count/denominator; it is
not added to total loss. Both windows and their counts are retained.

OCI Monitoring uses compute `CpuUtilization`, MySQL `CPUUtilization` and
`CurrentConnections` (dimension spelling resolved from live metric metadata),
and `oci_lbaas` `peakBandwidth`, `bytesSent`,
`bytesReceived` filtered to lbComponent=loadBalancer. Only fully enclosed
one-minute buckets in the recorded steady window are used. App CPU is the mean
of both nodes (not their sum); connection average and maximum are separate
queries; missing optional connection data is null. The raw metric summaries
and window are retained; bandwidth has documented units, never guessed Mbps.

Set the private `CWM_OCI_COST_REPORT_BUCKET` to the tenancy cost-report bucket
to enable read-only legacy OCI CSV cost report retrieval from namespace `bling`,
prefix `reports/cost-csv/`. Its value must never reach public output. The
controller needs the documented cross-tenancy cost-report read policy; the
harness does not create it. If access, files, USD currency, attribution, unique
line references, or complete run-window coverage for every scored resource
is unavailable, cost is null, not an estimate or a fabricated zero. Generator
and its boot volume are excluded. App boot volumes are included. Hourly billed
line amounts are allocated by actual overlap with the steady interval; this
allocation and its report source are explicit. Unsupported/new report formats
remain null rather than being silently guessed. Cost collection is bounded to
1000 reports / 100 MiB each. Published scoring code is untouched.

## Cleanup (future authorized execution only)

`node scripts/oci-cleanup-sweep.mjs prepare PRIVATE_MANIFEST PRIVATE_TFVARS_JSON`
records the exact variable-file SHA256, state lineage, attempt ID and resource
inventory. Run it as part of the future approved apply lifecycle, including
partial applies before rotating AD. Keep its output file private.
It can derive a partial attempt directly from runtime variables and state when
no Terraform outputs were published by a failed apply.

`node scripts/oci-cleanup-sweep.mjs immediate PRIVATE_MANIFEST` verifies those
inputs, destroys through Terraform with the identical full variable file,
then searches **the entire named compartment** for residual instances, boot/
block volumes, LBs, MySQL DB systems and VCNs. It records owned and unrelated
resources separately. Untaggable LB child resources and budget alerts are
allowed only when their parent is owned by the attempt. Foreign state, lineage
or variable drift fails closed. There is no force-delete fallback.

The external runner schedules destroy-only retries every two hours when the
report's next retry is set, and `24h PRIVATE_MANIFEST` after its delayed-sweep
time. Destroy intent, first-attempt time and a conservative retry deadline are
atomically persisted before fallible state/inventory reads, and the destroy
result is persisted before Search. A failed destroy always schedules a retry,
even if Search is empty or lagging. Unavailable Search remains inconclusive.
Clean inventory also requires a successful destroy and independently empty
Terraform state, which covers tenancy-scoped budgets absent from compartment
Search. The CLI returns failure for any inconclusive cleanup while retaining
the durable two-hour retry and 24-hour first-attempt clock.
The delayed check is inventory-only, repeats Search, lists backups for the exact
DB and checks Cost Analysis after destroy (the private
`CWM_OCI_TENANCY_ID` supplies its tenancy scope). Empty/lagging billing is explicitly
unverified, not proof of stopped charges. Continue reconciling delayed reports.
Resources still undeletable after 24h require the preregistered pause-and-ask.
Never delete unrelated resources. No cleanup command was run live for this
implementation task. The compatibility entry contains no guessed merge SHA.

## Offline checks

`node scripts/oci-no-load.mjs` is pure, with no context/cloud/workload dependency.
It reports all four keys, exact SCENARIO identities and the ladder positions.
It does **not** claim an applied stack is ready.

`node --test tests/adapter/*.test.mjs` and `bash scripts/ci.sh` retain all existing
provenance, history, scoring, completeness and byte-identity checks, adding OCI
tests and provider-mocked Terraform plan checks. Provider mocks never create
resources. Optional local Docker/MySQL correctness remains the original CI
gate and is skipped only when that environment is unavailable.
