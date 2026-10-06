import { PRIMARY_REGION, SECOND_REGION, TYPICAL_REGION } from './version.mjs';

/**
 * Campaign matrix implemented by this adapter.
 *
 * Public CWM accuracy-benchmark (GET /api/accuracy-benchmark) lists
 * idle / normal / peak / burst only. This repo's campaign schema and
 * honesty rules additionally require later-day and second-region holdouts
 * plus the three 1000 RPS diagnostics. No other CWM-internal keys were
 * found in-repo or in public CWM docs; those were not guessed.
 *
 * later-day and second-region are first-class scenarios with their own
 * keys, constraints, k6 SCENARIO tags, and run ids. They are not aliases
 * of `normal` or of the primary-region apply.
 *
 * typical-later-day and typical-later-day-300 mirror the later-day
 * constraint on the typical profile (load/typical.js, 100 and 300 RPS,
 * us-east-2). typical-second-region and typical-second-region-300 mirror
 * the second-region constraint at those same rates in us-west-2 only.
 * Other typical keys stay on us-east-2.
 */

export const SCENARIO_KEYS = Object.freeze([
  'idle',
  'normal',
  'peak',
  'burst',
  'pool-bound',
  'app-bound',
  'cpu-only',
  'later-day',
  'second-region',
  'typical-fit-20',
  'typical-fit-100',
  'typical-fit-200',
  'typical-holdout-300',
  'typical-saturation-500',
  'typical-later-day',
  'typical-later-day-300',
  'typical-second-region',
  'typical-second-region-300',
]);

function typicalScenario(key, rps, split, kind, optionalRung) {
  const required = optionalRung ? 'optional' : 'required';
  return {
    key,
    kind,
    rps,
    split,
    regionRole: 'primary',
    requiredRegion: TYPICAL_REGION,
    workload: { script: 'typical.js', envName: 'SCENARIO', envValue: key },
    expectedPoolSize: 250,
    expectedProfile: 'typical',
    expectedWorkers: 2,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description: optionalRung
      ? `Typical profile saturation rung at ${rps} total RPS (holdout, diagnostic, ${required}). Requires app_profile=typical, app_workers=2, and Terraform region ${TYPICAL_REGION}.`
      : `Typical profile ${split} rung at ${rps} total RPS (${required}). Requires app_profile=typical, app_workers=2, and Terraform region ${TYPICAL_REGION}.`,
  };
}

function typicalStabilityHoldout(key, rps, fields) {
  return {
    key,
    kind: 'holdout',
    split: 'holdout',
    workload: { script: 'typical.js', envName: 'SCENARIO', envValue: key },
    expectedPoolSize: 250,
    expectedProfile: 'typical',
    expectedWorkers: 2,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    ...fields,
    rps,
  };
}

const DEFINITIONS = {
  idle: {
    key: 'idle',
    kind: 'rung',
    rps: 10,
    split: 'fit',
    regionRole: 'primary',
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'idle' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description: 'Canonical idle rung at 10 RPS (fit split, primary region).',
  },
  normal: {
    key: 'normal',
    kind: 'rung',
    rps: 100,
    split: 'fit',
    regionRole: 'primary',
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'normal' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description: 'Canonical normal rung at 100 RPS (fit split, primary region).',
  },
  peak: {
    key: 'peak',
    kind: 'rung',
    rps: 500,
    split: 'fit',
    regionRole: 'primary',
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'peak' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description: 'Canonical peak rung at 500 RPS (fit split, primary region).',
  },
  burst: {
    key: 'burst',
    kind: 'rung',
    rps: 1000,
    split: 'holdout',
    regionRole: 'primary',
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'burst' },
    expectedPoolSize: 250,
    completeness: 'collected',
    requiresCompleteCollect: true,
    aliasOf: null,
    description:
      'Canonical burst rung at 1000 RPS (holdout). Completeness is derived from a full CloudWatch + k6 collect. The catalog does not badge burst as measured.',
  },
  'pool-bound': {
    key: 'pool-bound',
    kind: 'diagnostic',
    rps: 1000,
    split: 'holdout',
    regionRole: 'primary',
    workload: { script: 'diagnostics.js', envName: 'DIAGNOSTIC', envValue: 'pool-bound' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description: '1000 RPS diagnostic expecting APP_POOL_SIZE=250.',
  },
  'app-bound': {
    key: 'app-bound',
    kind: 'diagnostic',
    rps: 1000,
    split: 'holdout',
    regionRole: 'primary',
    workload: { script: 'diagnostics.js', envName: 'DIAGNOSTIC', envValue: 'app-bound' },
    expectedPoolSize: 40,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description:
      '1000 RPS diagnostic expecting APP_POOL_SIZE=40. Re-apply terraform with app_pool_size=40 first. Will not run against the default 250-pool topology.',
  },
  'cpu-only': {
    key: 'cpu-only',
    kind: 'diagnostic',
    rps: 1000,
    split: 'holdout',
    regionRole: 'primary',
    workload: { script: 'diagnostics.js', envName: 'DIAGNOSTIC', envValue: 'cpu-only' },
    expectedPoolSize: null,
    completeness: 'collected',
    requiresCompleteCollect: true,
    aliasOf: null,
    description:
      '1000 RPS diagnostic hitting GET /api/cpu-spin only. Requires complete per-node, CloudWatch, and k6 evidence.',
  },
  'later-day': {
    key: 'later-day',
    kind: 'holdout',
    rps: 100,
    split: 'holdout',
    regionRole: 'primary',
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'later-day' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    calendarConstraint: 'later-utc-day-than-fit',
    description:
      'Later-day holdout. Distinct scenario key and k6 SCENARIO=later-day. Setup fails unless the current UTC calendar day is strictly after the fit campaign date. Not a rename of normal.',
  },
  'second-region': {
    key: 'second-region',
    kind: 'holdout',
    rps: 100,
    split: 'holdout',
    regionRole: 'second',
    requiredRegion: SECOND_REGION,
    forbiddenRegion: PRIMARY_REGION,
    workload: { script: 'scenarios.js', envName: 'SCENARIO', envValue: 'second-region' },
    expectedPoolSize: 250,
    completeness: 'optional',
    requiresCompleteCollect: false,
    aliasOf: null,
    description:
      'Second-region holdout in us-west-2. Distinct scenario key and k6 SCENARIO=second-region. Setup fails if Terraform region is us-east-1. Not a rename of the primary-region run.',
  },
  'typical-fit-20': typicalScenario('typical-fit-20', 20, 'fit', 'rung', false),
  'typical-fit-100': typicalScenario('typical-fit-100', 100, 'fit', 'rung', false),
  'typical-fit-200': typicalScenario('typical-fit-200', 200, 'fit', 'rung', false),
  'typical-holdout-300': typicalScenario('typical-holdout-300', 300, 'holdout', 'holdout', false),
  'typical-saturation-500': typicalScenario('typical-saturation-500', 500, 'holdout', 'diagnostic', true),
  'typical-later-day': typicalStabilityHoldout('typical-later-day', 100, {
    regionRole: 'primary',
    requiredRegion: TYPICAL_REGION,
    calendarConstraint: 'later-utc-day-than-fit',
    description:
      `Typical-profile later-day holdout at 100 total RPS. Same load/typical.js mix as typical-fit-100. Requires app_profile=typical, app_workers=2, pool 250, and Terraform region ${TYPICAL_REGION}. Setup fails unless the current UTC calendar day is strictly after the fit campaign date (CWM_FIT_CAMPAIGN_DATE or adapter state). Not a rename of typical-fit-100 and not the lean later-day key.`,
  }),
  'typical-later-day-300': typicalStabilityHoldout('typical-later-day-300', 300, {
    regionRole: 'primary',
    requiredRegion: TYPICAL_REGION,
    calendarConstraint: 'later-utc-day-than-fit',
    description:
      `Typical-profile later-day holdout at 300 total RPS. Same load/typical.js mix as typical-holdout-300. Requires app_profile=typical, app_workers=2, pool 250, and Terraform region ${TYPICAL_REGION}. Setup fails unless the current UTC calendar day is strictly after the fit campaign date (CWM_FIT_CAMPAIGN_DATE or adapter state). Not a rename of typical-holdout-300 and not the lean later-day key.`,
  }),
  'typical-second-region': typicalStabilityHoldout('typical-second-region', 100, {
    regionRole: 'second',
    requiredRegion: SECOND_REGION,
    forbiddenRegion: TYPICAL_REGION,
    description:
      `Typical-profile second-region holdout at 100 total RPS in ${SECOND_REGION}. Same load/typical.js mix as typical-fit-100. Requires app_profile=typical, app_workers=2, and pool 250. Setup fails unless Terraform region is ${SECOND_REGION}. Other typical keys stay locked to ${TYPICAL_REGION}. Not a rename of the ${TYPICAL_REGION} typical apply and not the lean second-region key.`,
  }),
  'typical-second-region-300': typicalStabilityHoldout('typical-second-region-300', 300, {
    regionRole: 'second',
    requiredRegion: SECOND_REGION,
    forbiddenRegion: TYPICAL_REGION,
    description:
      `Typical-profile second-region holdout at 300 total RPS in ${SECOND_REGION}. Same load/typical.js mix as typical-holdout-300. Requires app_profile=typical, app_workers=2, and pool 250. Setup fails unless Terraform region is ${SECOND_REGION}. Other typical keys, including typical-holdout-300, stay locked to ${TYPICAL_REGION}. Not a rename of the ${TYPICAL_REGION} typical apply and not the lean second-region key.`,
  }),
};

export function scenariosRequiringCompleteCollect() {
  return SCENARIO_KEYS.filter((key) => DEFINITIONS[key].requiresCompleteCollect);
}

export function listScenarioKeys() {
  return [...SCENARIO_KEYS];
}

export function getScenario(key) {
  if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, key)) {
    const err = new Error(`unknown scenario: ${key}`);
    err.code = 'UNKNOWN_SCENARIO';
    throw err;
  }
  return { ...DEFINITIONS[key], workload: { ...DEFINITIONS[key].workload } };
}

export function scenarioCatalog() {
  return SCENARIO_KEYS.map((key) => getScenario(key));
}

export function isFitScenario(key) {
  const spec = getScenario(key);
  return spec.split === 'fit';
}

export function assertNotAliased(spec) {
  if (spec.aliasOf) {
    const err = new Error(
      `scenario ${spec.key} is aliased to ${spec.aliasOf}; the worker rejects incomplete scenario support`
    );
    err.code = 'ALIASED_SCENARIO';
    throw err;
  }
  if (spec.key === 'later-day' && spec.workload.envValue === 'normal') {
    const err = new Error('later-day must not execute as SCENARIO=normal');
    err.code = 'ALIASED_SCENARIO';
    throw err;
  }
  if (spec.key === 'second-region' && spec.workload.envValue === 'normal') {
    const err = new Error('second-region must not execute as SCENARIO=normal');
    err.code = 'ALIASED_SCENARIO';
    throw err;
  }
  const typicalStability =
    spec.expectedProfile === 'typical' &&
    (spec.calendarConstraint === 'later-utc-day-than-fit' || spec.regionRole === 'second');
  if (
    typicalStability &&
    (spec.workload.script !== 'typical.js' || spec.workload.envValue !== spec.key)
  ) {
    const err = new Error(
      `${spec.key} must execute load/typical.js with SCENARIO=${spec.key}, not an alias of a same-day typical rung or the lean holdout script`
    );
    err.code = 'ALIASED_SCENARIO';
    throw err;
  }
}

export function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function assertLaterDay(spec, now, fitDateUtc) {
  if (spec.calendarConstraint !== 'later-utc-day-than-fit') return;
  if (!fitDateUtc) {
    const err = new Error(
      spec.key === 'later-day'
        ? 'later-day requires a fit campaign UTC date (run a fit scenario first, or the worker must persist one). Refusing to alias normal on the same day.'
        : `${spec.key} requires a fit campaign UTC date (CWM_FIT_CAMPAIGN_DATE or adapter state). Refusing to run it on the fit campaign day.`
    );
    err.code = 'LATER_DAY_CONSTRAINT';
    throw err;
  }
  const today = utcDateString(now);
  if (!(today > fitDateUtc)) {
    const err = new Error(
      spec.key === 'later-day'
        ? `later-day holdout requires a later UTC calendar day than the fit campaign (${fitDateUtc}); today is ${today}. Not running as normal.`
        : `${spec.key} requires a later UTC calendar day than the fit campaign (${fitDateUtc}); today is ${today}. Not running as the same-day typical rung.`
    );
    err.code = 'LATER_DAY_CONSTRAINT';
    throw err;
  }
}

export function assertSecondRegion(spec, region) {
  if (spec.regionRole !== 'second') return;
  const required = spec.requiredRegion || SECOND_REGION;
  const forbidden = spec.forbiddenRegion || PRIMARY_REGION;
  if (!region) {
    const err = new Error(
      spec.key === 'second-region'
        ? `second-region requires Terraform region ${required}; no region was resolved. Not aliasing the primary-region run.`
        : `${spec.key} requires Terraform region ${required}; no region was resolved. Not aliasing the primary-region typical apply.`
    );
    err.code = 'SECOND_REGION_CONSTRAINT';
    throw err;
  }
  if (region === forbidden) {
    const err = new Error(
      spec.key === 'second-region'
        ? `second-region must run in ${required}, not primary region ${region}. This is not a rename of the us-east-1 run.`
        : `${spec.key} must run in ${required}, not ${region}. This is not a rename of the ${forbidden} typical apply.`
    );
    err.code = 'SECOND_REGION_CONSTRAINT';
    throw err;
  }
  if (region !== required) {
    const err = new Error(
      spec.key === 'second-region'
        ? `second-region holdout is documented as ${required}; Terraform region is ${region}`
        : `${spec.key} holdout is documented as ${required}; Terraform region is ${region}`
    );
    err.code = 'SECOND_REGION_CONSTRAINT';
    throw err;
  }
}

export function assertExpectedPool(spec, poolSize) {
  if (spec.expectedPoolSize == null) return;
  if (Number(poolSize) !== spec.expectedPoolSize) {
    const err = new Error(
      `scenario ${spec.key} expects APP_POOL_SIZE=${spec.expectedPoolSize}; /api/meta reported ${poolSize}. Re-apply terraform; do not pretend the other pool topology produced this run.`
    );
    err.code = 'POOL_MISMATCH';
    throw err;
  }
}

export function reportedProfile(meta) {
  if (meta && typeof meta.profile === 'string' && meta.profile.length > 0) return meta.profile;
  return 'lean';
}

export function reportedWorkers(meta) {
  if (meta && meta.workers != null && meta.workers !== '') {
    const workers = Number(meta.workers);
    if (Number.isFinite(workers)) return workers;
  }
  return 1;
}

export function assertExpectedProfile(spec, meta) {
  const expectedProfile = spec.expectedProfile || 'lean';
  const expectedWorkers = spec.expectedWorkers == null ? 1 : spec.expectedWorkers;
  const profile = reportedProfile(meta);
  const workers = reportedWorkers(meta);
  if (profile !== expectedProfile || workers !== expectedWorkers) {
    const err = new Error(
      `scenario ${spec.key} expects profile ${expectedProfile} with ${expectedWorkers} worker(s); ` +
        `/api/meta reported profile ${profile} with ${workers} worker(s). ` +
        'Refusing to run a lean scenario on a typical stack or a typical scenario on a lean stack.'
    );
    err.code = 'PROFILE_MISMATCH';
    throw err;
  }
}

export function assertTypicalRegion(spec, region) {
  if (spec.expectedProfile !== 'typical') return;
  const required = spec.requiredRegion || TYPICAL_REGION;
  if (region !== required) {
    const err = new Error(
      `scenario ${spec.key} requires Terraform region ${required}; resolved region is ${region || 'unset'}.`
    );
    err.code = 'TYPICAL_REGION_CONSTRAINT';
    throw err;
  }
}
