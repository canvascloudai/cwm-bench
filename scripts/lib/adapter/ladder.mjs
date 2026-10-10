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

export function assertP95TestId(spec, campaignId) {
  const id = campaignId == null ? '' : String(campaignId);
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
  const p95Scenario = typeof spec.key === 'string' && spec.key.startsWith('typical-p95-');
  const p95Id = P95_TEST_ID_RE.test(fromEnv) || P95_TEST_ID_RE.test(fromTf);
  if ((p95Scenario || p95Id) && fromEnv && fromTf && fromEnv !== fromTf) {
    const err = new Error(
      `CWM_CAMPAIGN_ID ${fromEnv} does not match terraform test_id ${fromTf}`,
    );
    err.code = 'TEST_ID_MISMATCH';
    throw err;
  }
  return assertP95TestId(spec, campaignIdFor(env, outputs));
}
