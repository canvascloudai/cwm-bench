/**
 * Worker adapter contract version. Capability-checked by the Admin Benchmarks worker.
 * 1.4.0 adds typical-later-day and typical-second-region.
 * Campaign typical-v1-20260927c was collected on 1.3.0; those artifacts stay at 1.3.0.
 */
export const ADAPTER_VERSION = '1.4.0';

/** Cleanup revision the application worker uses to destroy already-provisioned campaigns. */
export const PINNED_CLEANUP_REVISION = 'e95c5319b5c7b9cbd934735241b355df4144cab0';

export const PRIMARY_REGION = 'us-east-1';
export const SECOND_REGION = 'us-west-2';
export const TYPICAL_REGION = 'us-east-2';
