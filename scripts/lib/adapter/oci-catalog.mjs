/**
 * oci-holdout-v1 catalog wiring (adapter 1.9.0).
 *
 * Frozen catalog constants. Adapter 1.9.0 pins the provider-isolated
 * harness in oci.mjs: run and collect are supported. Implementation
 * does not grant paid authority: the follow-up measurement pin and
 * separate paid go are still required before any apply.
 */

export const OCI_HOLDOUT_REGION = 'us-ashburn-1';
export const OCI_HOLDOUT_LADDER = Object.freeze([10, 100, 500, 1000]);
export const OCI_HOLDOUT_WARMUP = '300s';
export const OCI_HOLDOUT_DURATION = '900s';
export const OCI_HOLDOUT_SPEND_CAP_USD = 25;
export const OCI_HOLDOUT_MAX_REPLACEMENTS = 3;
/** Stockout order for the single availability domain used by an apply. */
export const OCI_HOLDOUT_AD_ORDER = Object.freeze(['AD-1', 'AD-2', 'AD-3']);
/**
 * Apply id: oci-holdout-v{1|2}-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD.
 * v1 is the first OCI holdout; v2 (adapter 1.9.7) reruns the identical
 * harness and ladder under typical/oci-holdout-v2. The ad digit is the availability domain the apply used; the optional
 * letter counts whole-apply replacements within that AD (a = first).
 */
export const OCI_HOLDOUT_TEST_ID_RE = /^oci-holdout-v[12]-r[12]-ad[123][a-c]?-\d{8}$/;

/** Lean load/scenarios.js rung that carries each OCI key's request mix and rate. */
export const OCI_HOLDOUT_LEAN_RUNG = Object.freeze({
  10: 'idle',
  100: 'normal',
  500: 'peak',
  1000: 'burst',
});

/**
 * oci-holdout-v2 must run on a later day than oci-holdout-v1 (whose last rung
 * ended 2026-11-24 UTC / 2026-11-23 ET). v2 apply-id stamps (UTC apply date)
 * must be 20261124 or later; the prereg additionally requires every v2 apply to
 * start at or after 2026-11-24T05:00:00Z (00:00 ET). v1 ids are unaffected.
 * Rep spacing (v1: 12 h, different ET and UTC days; v2: same day allowed,
 * back to back after verified cleanup) is a controller rule, not enforced here.
 */
export const OCI_HOLDOUT_V2_EARLIEST_STAMP = '20261124';

export function assertOciHoldoutTestId(spec, testId) {
  if (spec.cloud !== 'oci') return;
  const text = String(testId || '');
  const stamp = text.slice(-8);
  const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}T00:00:00Z`);
  const validDate = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '') === stamp;
  const tooEarlyV2 = text.startsWith('oci-holdout-v2-') && stamp < OCI_HOLDOUT_V2_EARLIEST_STAMP;
  if (!OCI_HOLDOUT_TEST_ID_RE.test(text) || !validDate || tooEarlyV2) {
    const err = new Error(
      `scenario ${spec.key} requires test id oci-holdout-v{1|2}-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD; got ${testId || 'unset'}`,
    );
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
}
