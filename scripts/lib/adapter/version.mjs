/**
 * Worker adapter contract version. Capability-checked by the Admin Benchmarks worker.
 * 1.5.0 adds the typical-scale-v1 keys typical-scale-{1x,2x,3x}-{100,200,300}
 * and APP_COUNT_MISMATCH when the live app count differs from the key.
 * Existing typical keys expect 2 app servers. 1.4.0 added the typical
 * stability holdouts (typical-later-day, typical-later-day-300,
 * typical-second-region, typical-second-region-300); those artifacts stay
 * at 1.4.0. Campaign typical-v1-20260927c was collected on 1.3.0.
 */
export const ADAPTER_VERSION = '1.5.0';

/** Cleanup revision the application worker uses to destroy already-provisioned campaigns. */
export const PINNED_CLEANUP_REVISION = 'e95c5319b5c7b9cbd934735241b355df4144cab0';

export const PRIMARY_REGION = 'us-east-1';
export const SECOND_REGION = 'us-west-2';
export const TYPICAL_REGION = 'us-east-2';
