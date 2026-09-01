import { PRIMARY_REGION, SECOND_REGION } from './version.mjs';

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
]);

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
}

export function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function assertLaterDay(spec, now, fitDateUtc) {
  if (spec.key !== 'later-day') return;
  if (!fitDateUtc) {
    const err = new Error(
      'later-day requires a fit campaign UTC date (run a fit scenario first, or the worker must persist one). Refusing to alias normal on the same day.'
    );
    err.code = 'LATER_DAY_CONSTRAINT';
    throw err;
  }
  const today = utcDateString(now);
  if (!(today > fitDateUtc)) {
    const err = new Error(
      `later-day holdout requires a later UTC calendar day than the fit campaign (${fitDateUtc}); today is ${today}. Not running as normal.`
    );
    err.code = 'LATER_DAY_CONSTRAINT';
    throw err;
  }
}

export function assertSecondRegion(spec, region) {
  if (spec.key !== 'second-region') return;
  const required = spec.requiredRegion || SECOND_REGION;
  if (!region) {
    const err = new Error(
      `second-region requires Terraform region ${required}; no region was resolved. Not aliasing the primary-region run.`
    );
    err.code = 'SECOND_REGION_CONSTRAINT';
    throw err;
  }
  if (region === (spec.forbiddenRegion || PRIMARY_REGION)) {
    const err = new Error(
      `second-region must run in ${required}, not primary region ${region}. This is not a rename of the us-east-1 run.`
    );
    err.code = 'SECOND_REGION_CONSTRAINT';
    throw err;
  }
  if (region !== required) {
    const err = new Error(
      `second-region holdout is documented as ${required}; Terraform region is ${region}`
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
