import { ADAPTER_VERSION, PRIMARY_REGION, SECOND_REGION } from './version.mjs';
import { listScenarioKeys, scenarioCatalog } from './scenarios.mjs';
import { readTerraformOutputs } from './terraform.mjs';
import { describeSsmInstance, runRemoteShell } from './aws.mjs';

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
      knownGap: spec.knownGap,
      aliasOf: spec.aliasOf,
      calendarConstraint: spec.calendarConstraint || null,
      description: spec.description,
    })),
    matrixNote:
      'Implemented keys come from this repo (load/scenarios.js, load/diagnostics.js, schema holdout) and the public CWM accuracy rungs idle/normal/peak/burst. No unverified CWM-internal keys were added.',
    primaryRegion: PRIMARY_REGION,
    secondRegion: SECOND_REGION,
    knownGaps: ['burst'],
    honesty: {
      inventedMeasurements: false,
      burstIsKnownGap: true,
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

  const generatorSsm = await describeSsmInstance(runAws, outputs.generatorInstanceId, region);
  payload.ready.generatorSsm = generatorSsm.reachable;
  if (!generatorSsm.reachable) {
    const err = new Error(
      `generator ${outputs.generatorInstanceId} is not SSM-reachable (ping=${generatorSsm.pingStatus})`
    );
    err.code = 'GENERATOR_NOT_READY';
    throw err;
  }

  const appSsm = [];
  for (const instanceId of outputs.appInstanceIds) {
    const info = await describeSsmInstance(runAws, instanceId, region);
    appSsm.push(info);
  }
  payload.ready.appSsm = appSsm.every((info) => info.reachable);
  if (!payload.ready.appSsm) {
    const err = new Error('one or more app instances are not SSM-reachable');
    err.code = 'APP_NOT_READY';
    err.details = appSsm;
    throw err;
  }

  await runRemoteShell(runAws, {
    instanceId: outputs.generatorInstanceId,
    region,
    commands: [generatorReadyCommand()],
    timeoutSeconds: 120,
    waitTimeoutMs: ctx.deps.ssmWaitMs || 120_000,
    pollMs: ctx.deps.ssmPollMs || 1000,
    comment: 'cwm-bench wait-ready generator',
    now: ctx.deps.nowMs,
    wait: ctx.deps.wait,
  });

  for (const instanceId of outputs.appInstanceIds) {
    await runRemoteShell(runAws, {
      instanceId,
      region,
      commands: [healthCommand()],
      timeoutSeconds: 60,
      waitTimeoutMs: ctx.deps.ssmWaitMs || 60_000,
      pollMs: ctx.deps.ssmPollMs || 1000,
      comment: 'cwm-bench wait-ready app health',
      now: ctx.deps.nowMs,
      wait: ctx.deps.wait,
    });
  }

  payload.ready.appHealth = true;
  return payload;
}

export { capabilityPayload };
