import { ADAPTER_VERSION, PRIMARY_REGION, SECOND_REGION } from './version.mjs';
import { listScenarioKeys, scenarioCatalog, scenariosRequiringCompleteCollect } from './scenarios.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { describeSsmInstance, runRemoteShell } from './aws.mjs';
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
      description: spec.description,
    })),
    matrixNote:
      'Implemented keys come from this repo (load/scenarios.js, load/diagnostics.js, schema holdout) and the public CWM accuracy rungs idle/normal/peak/burst. No unverified CWM-internal keys were added. Burst and CPU-only require complete collect evidence before they are treated as measured.',
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
      const info = await describeSsmInstance(runAws, outputs.generatorInstanceId, region);
      if (!info.reachable) {
        throw pendingReadiness(
          `generator ${outputs.generatorInstanceId} SSM`,
          { instanceId: outputs.generatorInstanceId, ...info },
        );
      }
      return info;
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
  await retryReadiness(
    'generator bootstrap',
    () => runRemoteShell(runAws, {
      instanceId: outputs.generatorInstanceId,
      region,
      commands: [generatorReadyCommand()],
      timeoutSeconds: 120,
      waitTimeoutMs: remainingSsmWaitMs(),
      pollMs: ctx.deps.ssmPollMs || 1000,
      comment: 'cwm-bench wait-ready generator',
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
    }),
    controller,
  );

  for (const instanceId of outputs.appInstanceIds) {
    await retryReadiness(
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
      }),
      controller,
    );
  }

  payload.ready.appHealth = true;
  return payload;
}

export { capabilityPayload };
