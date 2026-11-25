/**
 * Worker adapter contract version. Capability-checked by the Admin Benchmarks worker.
 * 1.9.7 admits oci-holdout-v2 apply ids (oci-holdout-v{1|2}-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD)
 * in the adapter and terraform/oci, and derives the resource `campaign` tag
 * from the apply id (v1 ids still tag oci-holdout-v1). Scenario keys, ladder,
 * timings, load scripts, topology, parser, collect, cleanup and scoring are
 * unchanged from 1.9.6 (17376407).
 * 1.9.6 parses OCI raw evidence on Python 3.6 (no fromisoformat), compares
 * measurement windows in integer nanoseconds, and emits a specific reason
 * after OCI_RAW_EVIDENCE_INVALID. Both k6 summary shapes are accepted; the
 * launch command uses the frozen handleSummary only. A controller may
 * archive raw artifacts before the parser runs. Load scripts, preregistration,
 * Terraform, predictions, and scoring formulas are unchanged.
 * 1.9.5 checks OCI Load Balancer's live shape-name response field. Compute
 * shape checks, topology, workload, timing, predictions and scoring are unchanged.
 * 1.9.4 corrects OCI MySQL's live data-storage-size-in-gbs response field and
 * admits only the three local Ed25519 host-key states to guarded cleanup.
 * Successful empty OCI CLI backup lists are recognized explicitly; errors
 * remain inconclusive and can never be reported as zero backups.
 * No workload, topology, prediction, scoring or frozen-input changes.
 * 1.9.3 generates per-instance OCI SSH host identities in Terraform and supplies
 * them through cloud-init. The launcher pins known_hosts from authenticated
 * Terraform output before its first connection, without serial-console trust.
 * No engine, workload, prediction, timing, scoring or topology change.
 * 1.9.2 requires terraform/oci mysql_version (8.x, no default) and resolves it
 * before apply from a read-only `oci mysql version list`: newest 8.4.x, else
 * newest 8.x, else refuse. The chosen exact version is recorded in evidence.
 * The measurement pin is this pull request's merge commit, superseding
 * 72ede655 after a pre-rung MySQL 8.x postcondition fault with no
 * measurements. Kevin's approval to pin without editing the frozen
 * preregistration still applies. AWS and GCP keys, request mixes, timings,
 * scoring, and the 1.9.1 password rules are otherwise unchanged.
 * 1.9.1 meets OCI MySQL HeatWave admin-password rules in terraform/oci:
 * 8–32 characters with at least one uppercase, lowercase, numeric, and
 * special character (`special = true`, min_*, and an OCI-accepted
 * override_special that is safe for shell, EnvironmentFile, and the Node
 * mysql password field). The measurement pin is this pull request's merge
 * commit; Kevin approved pinning without editing the frozen preregistration.
 * AWS and GCP keys, request mixes, timings, scoring, and the 1.9.0 OCI
 * harness behavior are otherwise unchanged.
 * 1.9.0 pins the oci-holdout-v1 harness: terraform/oci and the OCI run/collect
 * adapter for oci-holdout-{10,100,500,1000} (us-ashburn-1, ladder
 * 10→100→500→1000 enforced, 300s warmup and 900s steady, load/oci-holdout.js,
 * apply id oci-holdout-v1-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD). Run and collect
 * are supported. The measurement pin is this harness merge commit; paid apply
 * still needs separate approval. AWS and GCP keys, request mixes, timings,
 * Terraform, scoring, and cleanup are unchanged.
 * 1.8.0 registers the oci-holdout-v1 keys oci-holdout-{10,100,500,1000}
 * (us-ashburn-1, ladder 10→100→500→1000 enforced, 300s warmup and 900s
 * steady, load/oci-holdout.js = the lean request function under each key's
 * own SCENARIO value, apply id
 * oci-holdout-v1-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD) as catalog entries only.
 * There is no OCI harness on this version: run and collect refuse every OCI
 * key with OCI_HARNESS_NOT_PINNED before any cloud call. AWS and GCP keys,
 * request mixes, timings, Terraform, scoring, and cleanup are unchanged.
 * 1.7.5 accepts gcp-holdout-v2 campaign IDs
 * (gcp-holdout-v2-r{1|2}[a-c]?-YYYYMMDD) on the existing
 * gcp-holdout-{300,400,500} keys and labels collect notes from the ID.
 * Zone suffixes remain a/b/c only. Request mix, timings, Terraform,
 * scoring, the 1.7.4 backend-health gate, gcp-fit-v1 behavior,
 * gcp-holdout-v1 IDs, and AWS behavior are unchanged.
 * 1.7.4 adds a GCP pre-load backend-health gate: run refuses to start k6 until
 * every MIG backend in the external HTTP load balancer backend service is
 * HEALTHY for 60 consecutive seconds. A timeout is a replaceable pre-rung
 * runner fault (GCP_BACKEND_HEALTH_TIMEOUT) and records a redacted health
 * snapshot plus timestamps in adapter state and collect evidence. Existing
 * scenario keys, request mix, timings, Terraform, scoring, and AWS behavior
 * are unchanged. Test adapter-state files are isolated per test.
 * 1.7.3 registers the gcp-holdout-v1 keys gcp-holdout-{300,400,500}
 * (ladder 300→400→500, 300s warmup and 900s steady) on the unchanged
 * gcp-fit-v1 topology, with holdout ID validation and collect labeling.
 * Request mix, timings, Terraform, scoring, gcp-fit-v1 behavior, and AWS
 * behavior are unchanged.
 * 1.7.2 changes GCP collector transport only: billing runs through
 * `bq query --use_legacy_sql=false` and Monitoring through the timeSeries.list
 * REST API (the gcloud routes the collector called do not exist), and VM CPU
 * series are selected raw by instance_id resolved from the existing role/test_id
 * labels. SQL, filters' semantics, windows, alignment and calculations are
 * unchanged; AWS behavior is unchanged. Historical artifacts keep their versions.
 * 1.7.1 fixes SSM truncation in DB-saturation collect using immutable,
 * SHA256-verified gzip snapshots and bounded redaction-safe hex chunks.
 * Measurement scripts, workload settings, and historical artifact versions are unchanged.
 * 1.7.0 adds the typical-dbsat-v1 keys typical-dbsat-{2x,3x,4x}-{300,...,1500}
 * (ascending ladder 300→1500, prefix-enforced; app_count 2/3/4), steady-window
 * P95 computed on the generator at collect, partial-step (breach) metadata,
 * RDS Performance Insights per-minute DB load by wait type, app pool-wait
 * metrics from /api/metrics, and an optional second generator. Other keys are
 * unchanged.
 * 1.6.1 records measurementSha on typical-p95-v1 collects only, from
 * CWM_MEASUREMENT_SHA and the app /api/meta gitSha. Those two must agree.
 * Other keys do not gain that field. 1.6.0 added the typical-p95-v1 keys
 * typical-p95-{1x,2x,3x}-{300,200,100}, the reverse ladder 300→200→100,
 * and gzipped k6 request-level output for those keys. It does not add a
 * k6 threshold. 1.5.0 added the
 * typical-scale-v1 keys typical-scale-{1x,2x,3x}-{100,200,300} and
 * APP_COUNT_MISMATCH when the live app count differs from the key.
 * Existing typical keys expect 2 app servers. Scale-v1 artifacts stay at
 * 1.5.0. 1.4.0 added the typical stability holdouts; those artifacts stay
 * at 1.4.0. Campaign typical-v1-20260927c was collected on 1.3.0.
 */
export const ADAPTER_VERSION = '1.9.7';

/** Cleanup revision the application worker uses to destroy already-provisioned campaigns. */
export const PINNED_CLEANUP_REVISION = 'e95c5319b5c7b9cbd934735241b355df4144cab0';

export const PRIMARY_REGION = 'us-east-1';
export const SECOND_REGION = 'us-west-2';
export const TYPICAL_REGION = 'us-east-2';
