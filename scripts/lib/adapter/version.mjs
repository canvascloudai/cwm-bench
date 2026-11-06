/**
 * Worker adapter contract version. Capability-checked by the Admin Benchmarks worker.
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
export const ADAPTER_VERSION = '1.7.4';

/** Cleanup revision the application worker uses to destroy already-provisioned campaigns. */
export const PINNED_CLEANUP_REVISION = 'e95c5319b5c7b9cbd934735241b355df4144cab0';

export const PRIMARY_REGION = 'us-east-1';
export const SECOND_REGION = 'us-west-2';
export const TYPICAL_REGION = 'us-east-2';
