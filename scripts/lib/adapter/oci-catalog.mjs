/**
 * oci-holdout-v1 catalog wiring (adapter 1.8.0).
 *
 * This module registers what the preregistration fixes: the OCI scenario
 * keys, region, ladder, timings and apply-id format. It does NOT contain an
 * OCI client, Terraform module, collector or cleanup sweep. Until the OCI
 * harness lands in a follow-up pull request (which moves the measurement pin
 * in typical/oci-holdout-v1/PREREGISTRATION.md), `run` and `collect` refuse
 * every OCI key with OCI_HARNESS_NOT_PINNED before touching any cloud API.
 * That refusal is deliberate: a runner on this pin must not apply.
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
 * Apply id: oci-holdout-v1-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD.
 * The ad digit is the availability domain the apply used; the optional
 * letter counts whole-apply replacements within that AD (a = first).
 */
export const OCI_HOLDOUT_TEST_ID_RE = /^oci-holdout-v1-r[12]-ad[123][a-c]?-\d{8}$/;

/** Lean load/scenarios.js rung that carries each OCI key's request mix and rate. */
export const OCI_HOLDOUT_LEAN_RUNG = Object.freeze({
  10: 'idle',
  100: 'normal',
  500: 'peak',
  1000: 'burst',
});

export function assertOciHoldoutTestId(spec, testId) {
  if (spec.cloud !== 'oci') return;
  if (!OCI_HOLDOUT_TEST_ID_RE.test(String(testId || ''))) {
    const err = new Error(
      `scenario ${spec.key} requires test id oci-holdout-v1-r{1|2}-ad{1|2|3}[a-c]?-YYYYMMDD; got ${testId || 'unset'}`,
    );
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
}

export function refuseOciUntilHarnessPinned(spec) {
  const err = new Error(
    `scenario ${spec.key} is registered for oci-holdout-v1, but this adapter has no OCI harness. ` +
      'Do not apply. The measurement pin moves to the OCI harness merge commit in a follow-up pull request ' +
      '(typical/oci-holdout-v1/PREREGISTRATION.md, "Measurement pin").',
  );
  err.code = 'OCI_HARNESS_NOT_PINNED';
  throw err;
}
