/**
 * Ladder order for a campaign apply.
 *
 * typical-p95-v1 runs 300 → 200 → 100 and rejects any other order.
 * typical-scale-v1 keeps 100 → 200 → 300 as metadata only: those keys
 * still run in whatever order the caller requests.
 */

export const P95_LADDER = Object.freeze([300, 200, 100]);
export const SCALE_LADDER = Object.freeze([100, 200, 300]);

export const P95_TEST_ID_RE = /^typical-p95-(1x|2x|3x)-r[1-3][a-z]?-\d{8}$/;

/**
 * typical-dbsat-v1: ascending 300 → 1500. Enforced as a prefix: an apply may
 * stop early (breach, or a confirmation apply that ends at S_next), but it may
 * never skip, reorder, or re-run a step.
 */
export const DBSAT_LADDER = Object.freeze([300, 500, 700, 900, 1100, 1300, 1500]);
/** typical-dbsat-v1: discovery r1/r2, confirmation c1, dry run d1; optional replacement letter. */
export const DBSAT_V1_TEST_ID_RE = /^typical-dbsat-(2x|3x|4x)-(r[12]|c1|d1)([a-z]?)-\d{8}$/;
/** typical-dbsat-pscap-v1 (max_prepared_stmt_count holdout): reps r1..r9; optional replacement letter. */
export const DBSAT_PSCAP_TEST_ID_RE = /^typical-dbsat-pscap-(2x|3x|4x)-(r[1-9])([a-z]?)-\d{8}$/;
/** Any typical-dbsat apply id (v1 or pscap). Group 1 or 4 is the scale. */
export const DBSAT_TEST_ID_RE = /^typical-dbsat-(?:(2x|3x|4x)-(?:r[12]|c1|d1)|pscap-(2x|3x|4x)-r[1-9])[a-z]?-\d{8}$/;

export function dbsatScale(id) {
  const match = DBSAT_TEST_ID_RE.exec(String(id || ''));
  return match ? (match[1] || match[2]) : null;
}

export function parseLadder(value) {
  if (value == null || value === '') return null;
  const parts = String(value).split(/[,\s]+/).filter(Boolean).map((item) => Number(item));
  if (parts.length === 0 || parts.some((item) => !Number.isFinite(item))) {
    const err = new Error(`CWM_LADDER is not a list of RPS values: ${value}`);
    err.code = 'LADDER_ORDER';
    throw err;
  }
  return parts;
}

export function sameLadder(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function resolveLadder(spec, env = {}) {
  const configured = Array.isArray(spec.ladder) ? spec.ladder.slice() : null;
  if (!configured) return { ladder: null, enforce: false };
  const fromEnv = parseLadder(env.CWM_LADDER);
  if (spec.enforceLadder) {
    if (fromEnv && !sameLadder(fromEnv, configured)) {
      const err = new Error(
        `scenario ${spec.key} ladder is ${configured.join('→')}; CWM_LADDER=${fromEnv.join(',')} does not match`,
      );
      err.code = 'LADDER_ORDER';
      throw err;
    }
    return { ladder: configured, enforce: true };
  }
  return { ladder: configured, enforce: false };
}

export function ladderHistory(state, campaignId) {
  const all = state && state.ladderByCampaign;
  const rows = all && all[campaignId];
  return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
}

export function assertLadderPosition(spec, plan, history) {
  const done = history.map((row) => row.rps);
  if (!plan.enforce || !plan.ladder) {
    return unenforcedMetadata(spec, plan, done);
  }
  for (let index = 0; index < done.length; index += 1) {
    if (done[index] !== plan.ladder[index]) {
      const err = new Error(
        `scenario ${spec.key} campaign ladder history ${done.join('→') || '(empty)'} is not a prefix of ${plan.ladder.join('→')}`,
      );
      err.code = 'LADDER_ORDER';
      throw err;
    }
  }
  if (done.length >= plan.ladder.length) {
    const err = new Error(
      `scenario ${spec.key} ladder ${plan.ladder.join('→')} is already complete on this apply. Replace the apply; do not re-run a rung.`,
    );
    err.code = 'LADDER_ORDER';
    throw err;
  }
  const expected = plan.ladder[done.length];
  if (spec.rps !== expected) {
    const err = new Error(
      `scenario ${spec.key} is ${spec.rps} RPS; this fresh-seed apply runs ${plan.ladder.join('→')} and the next rung is ${expected}`,
    );
    err.code = 'LADDER_ORDER';
    throw err;
  }
  return {
    rung_pos: done.length + 1,
    ladder_history: done.concat(spec.rps),
  };
}

function unenforcedMetadata(spec, plan, done) {
  if (!plan.ladder) return { rung_pos: null, ladder_history: null };
  const index = plan.ladder.indexOf(spec.rps);
  return {
    rung_pos: index >= 0 ? index + 1 : null,
    ladder_history: done.concat(spec.rps),
  };
}

function assertDbsatTestId(spec, id) {
  const dbsat = typeof spec.key === 'string' && spec.key.startsWith('typical-dbsat-');
  if (dbsat) {
    const scale = dbsatScale(id);
    if (!scale) {
      const err = new Error(
        `scenario ${spec.key} requires test id typical-dbsat-{2x|3x|4x}-{r1|r2|c1|d1}[letter]-YYYYMMDD or typical-dbsat-pscap-{2x|3x|4x}-r<n>[letter]-YYYYMMDD; got ${id || 'unset'}`,
      );
      err.code = 'TEST_ID_MISMATCH';
      throw err;
    }
    if (Number(scale[0]) !== spec.expectedAppCount) {
      const err = new Error(
        `scenario ${spec.key} expects ${spec.expectedAppCount} app server(s); test id ${id} is ${scale}`,
      );
      err.code = 'TEST_ID_MISMATCH';
      throw err;
    }
    return true;
  }
  if (DBSAT_TEST_ID_RE.test(id)) {
    const err = new Error(
      `test id ${id} is a typical-dbsat apply; refusing scenario ${spec.key}. Other campaign keys are not reused on it.`,
    );
    err.code = 'REUSED_KEY';
    throw err;
  }
  return false;
}

export function assertP95TestId(spec, campaignId) {
  const id = campaignId == null ? '' : String(campaignId);
  if (assertDbsatTestId(spec, id)) return id;
  const p95 = typeof spec.key === 'string' && spec.key.startsWith('typical-p95-');
  if (p95) {
    const match = P95_TEST_ID_RE.exec(id);
    if (!match) {
      const err = new Error(
        `scenario ${spec.key} requires test id typical-p95-{1x|2x|3x}-r{1..3}-YYYYMMDD with an optional letter suffix; got ${id || 'unset'}`,
      );
      err.code = 'TEST_ID_MISMATCH';
      throw err;
    }
    const count = Number(match[1][0]);
    if (count !== spec.expectedAppCount) {
      const err = new Error(
        `scenario ${spec.key} expects ${spec.expectedAppCount} app server(s); test id ${id} is ${match[1]}`,
      );
      err.code = 'TEST_ID_MISMATCH';
      throw err;
    }
    return id;
  }
  if (P95_TEST_ID_RE.test(id)) {
    const err = new Error(
      `test id ${id} is a typical-p95 apply; refusing scenario ${spec.key}. Fit, holdout, and scale keys are not reused on this campaign.`,
    );
    err.code = 'REUSED_KEY';
    throw err;
  }
  return id;
}

export function campaignIdFor(env, outputs) {
  if (env && env.CWM_CAMPAIGN_ID) return String(env.CWM_CAMPAIGN_ID);
  const testId = outputs && outputs.topology && outputs.topology.test_id;
  if (testId) return String(testId);
  return 'unset-campaign';
}

export function assertCampaignIdentity(spec, env, outputs) {
  const fromEnv = env && env.CWM_CAMPAIGN_ID ? String(env.CWM_CAMPAIGN_ID) : '';
  const fromTf = outputs && outputs.topology && outputs.topology.test_id
    ? String(outputs.topology.test_id)
    : '';
  const p95Scenario = typeof spec.key === 'string'
    && (spec.key.startsWith('typical-p95-') || spec.key.startsWith('typical-dbsat-'));
  const p95Id = P95_TEST_ID_RE.test(fromEnv) || P95_TEST_ID_RE.test(fromTf)
    || DBSAT_TEST_ID_RE.test(fromEnv) || DBSAT_TEST_ID_RE.test(fromTf);
  if ((p95Scenario || p95Id) && fromEnv && fromTf && fromEnv !== fromTf) {
    const err = new Error(
      `CWM_CAMPAIGN_ID ${fromEnv} does not match terraform test_id ${fromTf}`,
    );
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
  return assertP95TestId(spec, campaignIdFor(env, outputs));
}
