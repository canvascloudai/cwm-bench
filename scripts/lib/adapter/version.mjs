/**
 * Worker adapter contract version. Capability-checked by the Admin Benchmarks worker.
 * 1.4.0 adds the typical stability holdouts at 100 and 300 RPS:
 * typical-later-day, typical-later-day-300, typical-second-region,
 * and typical-second-region-300. 1.4.0 was not published with only the
 * 100 RPS keys, so the 300 RPS keys are part of the same contract.
 * Campaign typical-v1-20260927c was collected on 1.3.0; those artifacts stay at 1.3.0.
 */
export const ADAPTER_VERSION = '1.4.0';

/** Cleanup revision the application worker uses to destroy already-provisioned campaigns. */
export const PINNED_CLEANUP_REVISION = 'e95c5319b5c7b9cbd934735241b355df4144cab0';

export const PRIMARY_REGION = 'us-east-1';
export const SECOND_REGION = 'us-west-2';
export const TYPICAL_REGION = 'us-east-2';
