import { ADAPTER_VERSION, PRIMARY_REGION, SECOND_REGION } from './version.mjs';
import { listScenarioKeys, scenarioCatalog, scenariosRequiringCompleteCollect } from './scenarios.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { awsJson, describeSsmInstance, runRemoteShell } from './aws.mjs';
import { DBSAT_PSCAP_TEST_ID_RE, DBSAT_PSCAP16K_TEST_ID_RE, DBSAT_PSCAP24630_TEST_ID_RE } from './ladder.mjs';
import { redact } from './redact.mjs';

const DEFAULT_READINESS_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_READINESS_POLL_MS = 10 * 1000;

function capabilityPayload() {
  return {
    adapterVersion: ADAPTER_VERSION,
    supportedScenarios: listScenarioKeys(),
    scenarios: scenarioCatalog().map((spec) => ({
      key: spec.key,
      kind: spec.kind,
      rps: spec.rps,
      split: spec.split,
      regionRole: spec.regionRole,
      requiredRegion: spec.requiredRegion || null,
      completeness: spec.completeness,
      requiresCompleteCollect: Boolean(spec.requiresCompleteCollect),
      aliasOf: spec.aliasOf,
      calendarConstraint: spec.calendarConstraint || null,
      expectedAppCount: spec.expectedAppCount == null ? null : spec.expectedAppCount,
      description: spec.description,
    })),
    matrixNote:
      'Implemented keys come from this repo (load/scenarios.js, load/diagnostics.js, load/typical.js, schema holdout) and the public CWM accuracy rungs idle/normal/peak/burst. No unverified CWM-internal keys were added. Burst and CPU-only require complete collect evidence before they are treated as measured. typical-* keys run only against app_profile=typical and app_workers=2. They require us-east-2, except typical-second-region and typical-second-region-300, which require us-west-2. typical-later-day and typical-later-day-300 also require a later UTC day than the fit campaign. typical-scale-{1x,2x,3x}-{100,200,300} are us-east-2 validation keys and require topology app_count 1, 2, or 3. typical-p95-{1x,2x,3x}-{300,200,100} are the typical-p95-v1 keys, reverse ladder 300→200→100, and are not fit, holdout, or scale keys. typical-dbsat-{2x,3x,4x}-{300..1500} are the typical-dbsat-v1 keys, ascending ladder 300→1500, app_count 2, 3, or 4. Every other typical key expects 2 app servers (APP_COUNT_MISMATCH).',
    primaryRegion: PRIMARY_REGION,
    secondRegion: SECOND_REGION,
    knownGaps: [],
    requiresCompleteCollect: scenariosRequiringCompleteCollect(),
    honesty: {
      inventedMeasurements: false,
      burstRequiresCompleteCollect: true,
      cpuOnlyRequiresCompleteCollect: true,
      laterDayIsAliasOfNormal: false,
      secondRegionIsAliasOfPrimary: false,
    },
  };
}

function parseJsonObjects(text) {
  const src = String(text || '');
  const found = [];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < src.length; j += 1) {
      const ch = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push(JSON.parse(src.slice(i, j + 1)));
          } catch {
            // Ignore non-JSON braces in curl errors.
          }
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

export function metaFromStdout(text) {
  const objects = parseJsonObjects(text).filter(
    (obj) => obj && typeof obj === 'object' && (
      Object.prototype.hasOwnProperty.call(obj, 'poolSize') ||
      Object.prototype.hasOwnProperty.call(obj, 'profile') ||
      Object.prototype.hasOwnProperty.call(obj, 'gitSha')
    )
  );
  return objects.length ? objects[objects.length - 1] : null;
}

function appNodeReport(instanceId, meta) {
  return {
    instanceId,
    profile: meta && Object.prototype.hasOwnProperty.call(meta, 'profile') ? meta.profile : null,
    workers: meta && Object.prototype.hasOwnProperty.call(meta, 'workers') ? meta.workers : null,
    gitSha: meta && Object.prototype.hasOwnProperty.call(meta, 'gitSha') ? meta.gitSha : null,
  };
}

function healthCommand() {
  return [
    'set -euo pipefail',
    'curl -fsS --max-time 5 http://127.0.0.1:8080/health',
    'curl -fsS --max-time 5 http://127.0.0.1:8080/api/meta',
  ].join('\n');
}

function generatorReadyCommand() {
  return [
    'set -euo pipefail',
    'test -f /opt/cwm-bench/TARGET.env',
    'test -f /opt/cwm-bench/load/scenarios.js',
    'test -f /opt/cwm-bench/load/diagnostics.js',
    'command -v k6 >/dev/null',
    'k6 version',
    '# shellcheck disable=SC1091',
    '. /opt/cwm-bench/TARGET.env',
    'test -n "${TARGET:-}"',
    'curl -fsS --max-time 10 "$TARGET/health"',
  ].join('\n');
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function readinessConfig(ctx) {
  return {
    timeoutMs: positiveNumber(
      ctx.deps.readinessTimeoutMs ?? ctx.env.CWM_READINESS_TIMEOUT_MS,
      DEFAULT_READINESS_TIMEOUT_MS,
    ),
    pollMs: positiveNumber(
      ctx.deps.readinessPollMs ?? ctx.env.CWM_READINESS_POLL_MS,
      DEFAULT_READINESS_POLL_MS,
    ),
  };
}

function diagnosticFor(error) {
  return redact(
    [
      error?.message,
      error?.stderr ? `stderr: ${error.stderr}` : null,
      error?.stdout ? `stdout: ${error.stdout}` : null,
      error?.details ? `details: ${JSON.stringify(error.details)}` : null,
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(-2000),
  );
}

function pendingReadiness(label, details) {
  const error = new Error(`${label} is still starting`);
  error.code = 'READINESS_PENDING';
  error.retryable = true;
  error.details = details;
  return error;
}

function isRetryableReadinessError(error) {
  return error?.code === 'READINESS_PENDING' ||
    (error?.code === 'SSM_EXECUTION_FAILED' && error?.ssmStatus === 'Failed');
}

function readinessTimeout(label, timeoutMs, attempts, started, clock, lastError) {
  const elapsedMs = Math.max(0, clock() - started);
  const error = new Error(
    `${label} did not become ready within ${timeoutMs}ms after ${attempts} attempt(s) ` +
      `(${elapsedMs}ms elapsed): ${diagnosticFor(lastError) || 'no diagnostic available'}`,
  );
  error.code = 'READINESS_TIMEOUT';
  error.phase = label;
  error.attempts = attempts;
  error.elapsedMs = elapsedMs;
  error.lastFailure = diagnosticFor(lastError);
  return error;
}

async function retryReadiness(label, probe, controller) {
  let attempts = 0;
  let lastError;
  for (;;) {
    attempts += 1;
    try {
      return await probe();
    } catch (error) {
      if (!isRetryableReadinessError(error)) throw error;
      lastError = error;
      const remainingMs = controller.deadline - controller.clock();
      if (remainingMs <= 0) {
        throw readinessTimeout(
          label,
          controller.timeoutMs,
          attempts,
          controller.started,
          controller.clock,
          lastError,
        );
      }
      await controller.wait(Math.min(controller.pollMs, remainingMs));
    }
  }
}


export const MYSQL_DEFAULT_MAX_PREPARED_STMT_COUNT = 16382;

/**
 * typical-dbsat-pscap-v1: verify the live RDS max_prepared_stmt_count.
 * Runs only when the declared value differs from the engine default or the
 * campaign id is a pscap apply, so every earlier campaign's wait-ready is
 * unchanged (no extra AWS calls).
 */
export function preparedStmtCheckRequired(outputs, env = {}) {
  const declared = outputs.mysqlMaxPreparedStmtCount;
  const id = String((env && env.CWM_CAMPAIGN_ID) || (outputs.topology && outputs.topology.test_id) || '');
  return (declared != null && declared !== MYSQL_DEFAULT_MAX_PREPARED_STMT_COUNT)
    || DBSAT_PSCAP_TEST_ID_RE.test(id)
    || DBSAT_PSCAP16K_TEST_ID_RE.test(id)
    || DBSAT_PSCAP24630_TEST_ID_RE.test(id);
}

/** typical-dbsat-pscap-v1 §2: the only intervention is the MySQL maximum. */
export const PSCAP_MAX_PREPARED_STMT_COUNT = 65528;

/** typical-dbsat-pscap16k-2x-v1 §2: the only intervention vs conn-2x-v1.1 is the MySQL maximum, back at 16,382. */
export const PSCAP16K_MAX_PREPARED_STMT_COUNT = 16382;

/** typical-dbsat-pscap24630-2x-v1 §2: the only intervention vs conn-2x-v1.1 is the MySQL maximum, set to 24,630. */
export const PSCAP24630_MAX_PREPARED_STMT_COUNT = 24630;

export async function checkPreparedStmtParameter(runAws, outputs, region, env = {}) {
  const declared = outputs.mysqlMaxPreparedStmtCount;
  const id = String((env && env.CWM_CAMPAIGN_ID) || (outputs.topology && outputs.topology.test_id) || '');
  if (DBSAT_PSCAP16K_TEST_ID_RE.test(id) && declared !== PSCAP16K_MAX_PREPARED_STMT_COUNT) {
    const err = new Error(`pscap16k apply ${id} must declare mysql_max_prepared_stmt_count=${PSCAP16K_MAX_PREPARED_STMT_COUNT}; got ${declared == null ? 'unset' : declared}`);
    err.code = 'DB_PARAMETER_MISMATCH';
    throw err;
  }
  if (DBSAT_PSCAP24630_TEST_ID_RE.test(id) && declared !== PSCAP24630_MAX_PREPARED_STMT_COUNT) {
    const err = new Error(`pscap24630 apply ${id} must declare mysql_max_prepared_stmt_count=${PSCAP24630_MAX_PREPARED_STMT_COUNT}; got ${declared == null ? 'unset' : declared}`);
    err.code = 'DB_PARAMETER_MISMATCH';
    throw err;
  }
  if (DBSAT_PSCAP_TEST_ID_RE.test(id) && declared !== PSCAP_MAX_PREPARED_STMT_COUNT) {
    const err = new Error(`pscap apply ${id} must declare mysql_max_prepared_stmt_count=${PSCAP_MAX_PREPARED_STMT_COUNT}; got ${declared == null ? 'unset' : declared}`);
    err.code = 'DB_PARAMETER_MISMATCH';
    throw err;
  }
  if (declared == null || !outputs.dbParameterGroupName || !outputs.rdsIdentifier) {
    const err = new Error('max_prepared_stmt_count check needs terraform outputs mysql_max_prepared_stmt_count, db_parameter_group_name and rds_identifier');
    err.code = 'DB_PARAMETER_MISMATCH';
    throw err;
  }
  const params = await awsJson(runAws, [
    'rds', 'describe-db-parameters',
    '--db-parameter-group-name', outputs.dbParameterGroupName,
    '--region', region,
    '--query', "Parameters[?ParameterName=='max_prepared_stmt_count']",
    '--output', 'json',
  ]);
  const rows = Array.isArray(params) ? params : (params.Parameters || []);
  const row = rows.find((item) => item && item.ParameterName === 'max_prepared_stmt_count') || rows[0];
  const live = row && row.ParameterValue != null && row.ParameterValue !== '' ? Number(row.ParameterValue) : null;
  const effective = live == null ? MYSQL_DEFAULT_MAX_PREPARED_STMT_COUNT : live;
  if (effective !== declared) {
    const err = new Error(`live max_prepared_stmt_count ${live == null ? 'unset (engine default 16382)' : live} != declared ${declared}`);
    err.code = 'DB_PARAMETER_MISMATCH';
    throw err;
  }
  const inst = await awsJson(runAws, [
    'rds', 'describe-db-instances',
    '--db-instance-identifier', outputs.rdsIdentifier,
    '--region', region,
    '--query', 'DBInstances[0].DBParameterGroups',
    '--output', 'json',
  ]);
  const groups = Array.isArray(inst) ? inst : [];
  const group = groups.find((item) => item && item.DBParameterGroupName === outputs.dbParameterGroupName);
  const applyStatus = group ? group.ParameterApplyStatus : null;
  if (applyStatus !== 'in-sync') {
    throw pendingReadiness('RDS parameter group apply status', { applyStatus });
  }
  return {
    parameter: 'max_prepared_stmt_count',
    declared,
    live: effective,
    source: live == null ? 'engine-default' : (row.Source || 'user'),
    parameterGroup: outputs.dbParameterGroupName,
    applyStatus,
  };
}

export async function waitReady(ctx) {
  const capability = capabilityPayload();
  const payload = {
    ok: true,
    ...capability,
    provisioned: false,
    ready: {
      terraformOutputs: false,
      appHealth: false,
      generatorSsm: false,
      appSsm: false,
    },
  };

  let outputs;
  try {
    outputs = await readTerraformOutputs(ctx.deps);
  } catch (err) {
    if (
      err &&
      (err.code === 'NOT_PROVISIONED' ||
        err.code === 'TERRAFORM_UNAVAILABLE' ||
        err.code === 'TERRAFORM_OUTPUT_FAILED')
    ) {
      payload.ready.note =
        'Terraform outputs are not available (not provisioned yet, or terraform CLI is absent). Returning capability-check only so the worker can inspect adapterVersion and supportedScenarios before provisioning.';
      payload.ready.terraformError = err.code;
      return payload;
    }
    throw err;
  }

  payload.provisioned = true;
  payload.ready.terraformOutputs = true;
  payload.terraform = {
    region: outputs.region,
    albDns: outputs.albDns,
    resolvedAmiId: outputs.resolvedAmiId,
    amiSource: outputs.amiSource,
    generatorInstanceId: outputs.generatorInstanceId,
    appInstanceIds: outputs.appInstanceIds,
    rdsIdentifier: outputs.rdsIdentifier,
  };

  const region = outputs.region || ctx.env.AWS_REGION || PRIMARY_REGION;
  const runAws = ctx.deps.runAws;
  if (typeof runAws !== 'function') {
    const err = new Error('AWS runner is not configured; cannot verify SSM readiness');
    err.code = 'AWS_UNAVAILABLE';
    throw err;
  }

  const config = readinessConfig(ctx);
  const clock = ctx.deps.nowMs || Date.now;
  const wait = ctx.deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const controller = {
    timeoutMs: config.timeoutMs,
    pollMs: config.pollMs,
    started: clock(),
    clock,
    deadline: clock() + config.timeoutMs,
    wait,
  };

  const generatorSsm = await retryReadiness(
    'generator SSM',
    async () => {
      // Every generator (generator_count 1 or 2) must be reachable.
      const ids = Array.isArray(outputs.generatorInstanceIds) && outputs.generatorInstanceIds.length > 0
        ? outputs.generatorInstanceIds
        : [outputs.generatorInstanceId];
      let first = null;
      for (const instanceId of ids) {
        const info = await describeSsmInstance(runAws, instanceId, region);
        if (!info.reachable) {
          throw pendingReadiness(`generator ${instanceId} SSM`, { instanceId, ...info });
        }
        first = first || info;
      }
      return first;
    },
    controller,
  );
  payload.ready.generatorSsm = generatorSsm.reachable;

  const appSsm = await retryReadiness(
    'app SSM',
    async () => {
      const infos = [];
      for (const instanceId of outputs.appInstanceIds) {
        infos.push(await describeSsmInstance(runAws, instanceId, region));
      }
      if (!infos.every((info) => info.reachable)) {
        throw pendingReadiness('one or more app instances SSM', {
          instances: infos,
        });
      }
      return infos;
    },
    controller,
  );
  payload.ready.appSsm = appSsm.every((info) => info.reachable);

  const remainingSsmWaitMs = () => Math.max(
    1,
    Math.min(ctx.deps.ssmWaitMs || 120_000, controller.deadline - controller.clock()),
  );
  const generatorIds = Array.isArray(outputs.generatorInstanceIds) && outputs.generatorInstanceIds.length > 0
    ? outputs.generatorInstanceIds
    : [outputs.generatorInstanceId];
  for (const generatorId of generatorIds) await retryReadiness(
    `generator bootstrap ${generatorId}`,
    () => runRemoteShell(runAws, {
      instanceId: generatorId,
      region,
      commands: [generatorReadyCommand()],
      timeoutSeconds: 120,
      waitTimeoutMs: remainingSsmWaitMs(),
      pollMs: ctx.deps.ssmPollMs || 1000,
      comment: 'cwm-bench wait-ready generator',
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
      throwOnFailure: true,
    }),
    controller,
  );

  const appNodes = [];
  for (const instanceId of outputs.appInstanceIds) {
    const invocation = await retryReadiness(
      `app ${instanceId} health`,
      () => runRemoteShell(runAws, {
        instanceId,
        region,
        commands: [healthCommand()],
        timeoutSeconds: 60,
        waitTimeoutMs: Math.min(ctx.deps.ssmWaitMs || 60_000, remainingSsmWaitMs()),
        pollMs: ctx.deps.ssmPollMs || 1000,
        comment: 'cwm-bench wait-ready app health',
        now: ctx.deps.nowMs,
        wait: ctx.deps.wait,
        throwOnFailure: true,
    }),
      controller,
    );
    appNodes.push(appNodeReport(instanceId, metaFromStdout(invocation && invocation.stdout)));
  }

  payload.appNodes = appNodes;
  payload.ready.appHealth = true;

  if (preparedStmtCheckRequired(outputs, ctx.env)) {
    payload.dbParameters = await retryReadiness(
      'RDS max_prepared_stmt_count',
      () => checkPreparedStmtParameter(runAws, outputs, region, ctx.env),
      controller,
    );
    payload.ready.dbParameters = true;
  }
  return payload;
}

export { capabilityPayload };
