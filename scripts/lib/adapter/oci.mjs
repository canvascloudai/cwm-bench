import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ADAPTER_VERSION } from './version.mjs';
import { getScenario } from './scenarios.mjs';
import { requireRunIdentity } from './identity.mjs';
import { loadState, updateAdapterState } from './state.mjs';
import { assertLadderPosition, resolveLadder } from './ladder.mjs';
import { assertOciHoldoutTestId } from './oci-catalog.mjs';
import { decodeTerraformOutput } from './terraform.mjs';
import { collectCommand, fault, launchCommand, ociJson, quote, runDirectory, safeOci, ssh } from './oci-commands.mjs';
import { monitoring, costReports } from './oci-evidence.mjs';

export const OCI_ARCHIVE_BEFORE_PARSE = true;

export async function ociOutputs(ctx) {
  if (typeof ctx.deps.runOciTerraform !== 'function') throw fault('OCI_TERRAFORM_UNAVAILABLE');
  const r = await ctx.deps.runOciTerraform(['output', '-json', 'oci']);
  if (r.code !== 0) throw fault('NOT_PROVISIONED');
  // `output -json oci` returns the value, not the all-outputs wrapper.
  let f;
  try { f = JSON.parse(r.stdout); } catch { throw fault('OCI_OUTPUT_INVALID'); }
  if (f?.oci) f = decodeTerraformOutput(f).oci;
  if (f.cloud !== 'oci' || f.region !== 'us-ashburn-1' || f.compartment_name !== 'cwm-bench-oci')
    throw fault('OCI_TOPOLOGY_MISMATCH');
  return f;
}

export function assertConfiguration(f, spec, env) {
  assertOciHoldoutTestId(spec, f.test_id);
  if (env.CWM_CAMPAIGN_ID !== f.test_id) throw fault('TEST_ID_MISMATCH');
  const ad = /-ad([123])/.exec(f.test_id)[1];
  if (!f.availability_domain?.endsWith(`AD-${ad}`)) throw fault('TEST_ID_MISMATCH');
  if (!/^[0-9a-f]{40}$/.test(f.measurement_sha || '')) throw fault('MEASUREMENT_SHA_MISSING');
  if (env.CWM_MEASUREMENT_SHA && env.CWM_MEASUREMENT_SHA !== f.measurement_sha) throw fault('MEASUREMENT_SHA_MISMATCH');
  if ((env.CWM_WARMUP && env.CWM_WARMUP !== '300s') ||
      (env.CWM_DURATION && env.CWM_DURATION !== '900s')) throw fault('OCI_TIMING_MISMATCH');
  const expected = {
    app_count: 2, shape: 'VM.Standard.E4.Flex', ocpus: 2, memory_gb: 16,
    profile: 'lean', pool: 250, workers: 1, node_major: 20,
    db_shape: 'MySQL.2', db_storage_gb: 100, max_connections: 1000,
    heatwave: false, ha: false, backups: false, delete_protected: false,
    final_backup: 'SKIP_FINAL_BACKUP', k6: 'v0.54.0', lb_min: 10, lb_max: 100,
  };
  if (Object.entries(expected).some(([k, v]) => f.expected?.[k] !== v) ||
      f.app_ids?.length !== 2 || f.app_ips?.length !== 2 ||
      new Set([...f.app_ids, f.generator_id]).size !== 3) throw fault('OCI_TOPOLOGY_MISMATCH');
  if (!/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}$/.test(f.target || '')) throw fault('OCI_TARGET_INVALID');
  if (!String(f.mysql_version || '').startsWith('8.')) throw fault('OCI_MYSQL_VERSION_MISMATCH');
  runDirectory({ campaignId: f.test_id, runId: 'configuration', scenario: spec.key });
}

export function applyFingerprint(f) {
  return createHash('sha256').update(JSON.stringify([
    f.compartment_id, f.availability_domain, f.app_ids, f.generator_id, f.db_id, f.lb_id, f.measurement_sha,
  ])).digest('hex');
}

export async function checkReady(ctx, f, reconnects = []) {
  const read = (args) => ociJson(ctx, args);
  const nodes = [...f.app_ids, f.generator_id];
  for (const id of nodes) {
    const vm = await read(['compute', 'instance', 'get', '--instance-id', id]);
    if (vm['lifecycle-state'] !== 'RUNNING' || vm['compartment-id'] !== f.compartment_id ||
        vm['availability-domain'] !== f.availability_domain || vm.shape !== 'VM.Standard.E4.Flex' ||
        vm['shape-config']?.ocpus !== 2 || vm['shape-config']?.['memory-in-gbs'] !== 16 ||
        vm['freeform-tags']?.test_id !== f.test_id) throw fault('OCI_INSTANCE_MISMATCH');
  }
  const db = await read(['mysql', 'db-system', 'get', '--db-system-id', f.db_id]);
  if (db['lifecycle-state'] !== 'ACTIVE' || db['compartment-id'] !== f.compartment_id ||
      db['availability-domain'] !== f.availability_domain || db['shape-name'] !== 'MySQL.2' ||
      db['data-storage-size-in-gbs'] !== 100 || db['is-highly-available'] !== false ||
      db['is-heat-wave-cluster-attached'] !== false || db['backup-policy']?.['is-enabled'] !== false ||
      db['deletion-policy']?.['is-delete-protected'] !== false ||
      db['deletion-policy']?.['final-backup'] !== 'SKIP_FINAL_BACKUP' ||
      db['configuration-id'] !== f.db_configuration_id || !/^8\./.test(db['mysql-version'] || '') ||
      db['freeform-tags']?.test_id !== f.test_id) throw fault('OCI_DATABASE_MISMATCH');
  const config = await read(['mysql', 'configuration', 'get', '--configuration-id', f.db_configuration_id]);
  if (Number(config.variables?.['max-connections']) !== 1000) throw fault('OCI_DB_CONNECTIONS_MISMATCH');
  const lb = await read(['lb', 'load-balancer', 'get', '--load-balancer-id', f.lb_id]);
  if (lb['lifecycle-state'] !== 'ACTIVE' || lb['compartment-id'] !== f.compartment_id ||
      lb['shape-name'] !== 'flexible' || lb['is-private'] !== false ||
      lb['shape-details']?.['minimum-bandwidth-in-mbps'] !== 10 ||
      lb['shape-details']?.['maximum-bandwidth-in-mbps'] !== 100 ||
      lb.listeners?.http?.protocol !== 'HTTP' || lb.listeners?.http?.port !== 80 ||
      lb['freeform-tags']?.test_id !== f.test_id) throw fault('OCI_LB_MISMATCH');
  const health = await read(['lb', 'backend-set-health', 'get', '--load-balancer-id', f.lb_id, '--backend-set-name', 'app']);
  if (health.status !== 'OK' || health['total-backend-count'] !== 2) throw fault('OCI_BACKEND_NOT_READY');
  const versions = [];
  for (const host of f.app_ips) {
    const text = await ssh(ctx, host, [
      'set -euo pipefail', 'node --version',
      'set -a; source /etc/cwm-app.env; set +a',
      'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h "$MYSQL_HOST" -u "$MYSQL_USER" -N -B -e "SELECT @@GLOBAL.max_connections, @@version"',
      "curl -fsS --max-time 10 http://127.0.0.1:8080/api/products/1 >/dev/null",
      'curl -fsS --max-time 10 http://127.0.0.1:8080/api/meta',
    ].join('\n'), { evidence: reconnects });
    const node = text.match(/^v20\.[^\n]+/m)?.[0];
    const sql = text.match(/^1000\t(8\.[^\n]+)/m)?.[1];
    let meta;
    try { meta = JSON.parse(text.slice(text.indexOf('{'))); } catch { throw fault('OCI_APP_META_INVALID'); }
    if (!node || !sql || meta.poolSize !== 250 || meta.gitSha !== f.measurement_sha ||
        (meta.profile && meta.profile !== 'lean') || (meta.workers != null && meta.workers !== 1))
      throw fault('OCI_APP_CONFIG_MISMATCH');
    versions.push({ node, mysql: sql, maxConnections: 1000, source: 'applied SQL readback' });
  }
  const generator = await ssh(ctx, f.generator_ip,
    `set -euo pipefail\nk6 version\ngit -C /opt/cwm-source rev-parse HEAD\ncurl -fsS --max-time 10 ${quote(`${f.target}/api/products/1`)} >/dev/null`,
    { evidence: reconnects });
  if (!/\bk6 v0\.54\.0\b/.test(generator) || !generator.includes(f.measurement_sha)) throw fault('OCI_GENERATOR_MISMATCH');
  return { versions, k6: 'v0.54.0', backendCount: 2, maxConnections: 1000, appliedReadback: true };
}

async function lock(ctx) {
  if (ctx.deps.ociLock) return ctx.deps.ociLock();
  await mkdir(path.dirname(ctx.statePath), { recursive: true });
  const file = `${ctx.statePath}.oci-lock`;
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch { throw fault('OCI_CONTROLLER_LOCKED', 'Inspect existing controller ownership; never run concurrent ladders'); }
  return async () => { await handle.close(); await unlink(file); };
}

export async function runOciScenario(ctx, spec) {
  const identity = requireRunIdentity(ctx.env, spec.key);
  runDirectory(identity);
  assertOciHoldoutTestId(spec, identity.campaignId);
  const plan = resolveLadder(spec, ctx.env);
  const release = await lock(ctx);
  try {
    const f = await ociOutputs(ctx);
    assertConfiguration(f, spec, ctx.env);
    const fingerprint = applyFingerprint(f);
    const state = await loadState(ctx.statePath, ctx.deps.fs || {});
    const saved = state.oci?.[identity.campaignId];
    if (saved && saved.fingerprint !== fingerprint) throw fault('OCI_APPLY_STATE_MISMATCH');
    if (saved?.fault) throw fault('OCI_APPLY_FAULTED');
    if (saved?.pending && JSON.stringify(saved.pending) !== JSON.stringify(identity)) throw fault('OCI_RUN_PENDING');
    const history = saved?.history || [];
    const ladder = assertLadderPosition(spec, plan, history);
    const reconnects = [];
    // On controller reattachment, the original readiness proof is already
    // durable. Do not issue synthetic product requests during the live rung.
    const ready = saved?.pending ? saved.ready : await checkReady(ctx, f, reconnects);
    if (!ready) throw fault('OCI_PENDING_READINESS_MISSING');
    await updateAdapterState(ctx.statePath, (s) => {
      s.oci ||= {};
      s.oci[identity.campaignId] = { fingerprint, history, pending: identity, ready };
    }, ctx.deps.fs || {});
    try {
      await ssh(ctx, f.generator_ip, launchCommand(f, identity), { evidence: reconnects });
      const dir = runDirectory(identity);
      const now = ctx.deps.nowMs || Date.now;
      const deadline = now() + 1800_000;
      let marker;
      for (let n = 0; n < 121 && now() < deadline; n++) {
        const text = await ssh(ctx, f.generator_ip,
          `if test -f ${quote(`${dir}/complete.json`)}; then cat ${quote(`${dir}/complete.json`)}; else echo OCI_RUNNING; fi`,
          { evidence: reconnects });
        if (text.trim() !== 'OCI_RUNNING') {
          try { marker = JSON.parse(text); } catch { throw fault('OCI_MARKER_INVALID'); }
          break;
        }
        await (ctx.deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms))))(15_000);
      }
      // A campaign controller may retain the immutable artifacts before the
      // parser is allowed to reject them. Also retain a failed k6 exit.
      if (marker && ctx.deps.archiveOciRung) {
        await ctx.deps.archiveOciRung({ identity, fields: f, marker });
      }
      if (!marker || marker.exitCode !== 0) throw fault('OCI_GENERATOR_FAILED');
      assertEvidenceIdentity(marker, identity, f);
      // A rung isn't successful until its raw samples can actually be recovered.
      const raw = await recoverRaw(ctx, f, identity, reconnects);
      await updateAdapterState(ctx.statePath, (s) => {
        const lane = s.oci[identity.campaignId];
        lane.pending = null;
        lane.history.push({ ...identity, rps: spec.rps, marker, rawSha256: raw.rawSha256 });
      }, ctx.deps.fs || {});
      return safeOci({ ok: true, cloud: 'oci', adapterVersion: ADAPTER_VERSION, ...identity,
        ladder: plan.ladder, ...ladder, ready, reconnects, marker,
        rawSha256: raw.rawSha256, teardown: { k6Stopped: false, reason: 'completed independently; never killed on disconnect' } });
    } catch (error) {
      error.ociEvidence = { reconnects, ...identity };
      await updateAdapterState(ctx.statePath, (s) => {
        s.oci[identity.campaignId].fault = true;
        s.oci[identity.campaignId].faultEvidence = { code: error.code || 'OCI_RUN_FAILED', reconnects };
      }, ctx.deps.fs || {});
      throw error;
    }
  } finally { await release(); }
}

function assertEvidenceIdentity(marker, identity, f) {
  if (['campaignId', 'runId', 'scenario'].some((k) => marker[k] !== identity[k]) ||
      marker.measurementSha !== f.measurement_sha || marker.exitCode !== 0 ||
      !Number.isFinite(Date.parse(marker.startedAt)) ||
      Date.parse(marker.endedAt) < Date.parse(marker.startedAt) + 1200_000) throw fault('OCI_EVIDENCE_IDENTITY');
}

async function recoverRaw(ctx, f, identity, reconnects) {
  let raw;
  try { raw = JSON.parse(await ssh(ctx, f.generator_ip, collectCommand(identity), { evidence: reconnects })); }
  catch { throw fault('OCI_RAW_UNRECOVERABLE'); }
  assertEvidenceIdentity(raw.identity, identity, f);
  if (!/^[a-f0-9]{64}$/.test(raw.rawSha256 || '') || !raw.steady?.rawSamples ||
      !raw.whole?.rawSamples || !(raw.rawBytes > 0)) throw fault('OCI_RAW_UNRECOVERABLE');
  return raw;
}

export async function collectOciScenario(ctx, spec) {
  const identity = requireRunIdentity(ctx.env, spec.key);
  const f = await ociOutputs(ctx);
  assertConfiguration(f, spec, ctx.env);
  const state = await loadState(ctx.statePath, ctx.deps.fs || {});
  const lane = state.oci?.[identity.campaignId];
  const row = lane?.history?.find((r) => r.runId === identity.runId && r.scenario === spec.key);
  if (!row || lane.fingerprint !== applyFingerprint(f) || lane.fault) throw fault('OCI_RUN_NOT_RECORDED');
  const reconnects = [];
  let raw;
  try {
    raw = await recoverRaw(ctx, f, identity, reconnects);
    if (raw.rawSha256 !== row.rawSha256 || JSON.stringify(raw.identity) !== JSON.stringify(row.marker)) throw fault('OCI_RAW_CHANGED');
  } catch (error) {
    await updateAdapterState(ctx.statePath, (s) => { s.oci[identity.campaignId].fault = true; }, ctx.deps.fs || {});
    throw error;
  }
  const start = new Date(Date.parse(raw.identity.startedAt) + 300_000).toISOString();
  const end = new Date(Date.parse(raw.identity.startedAt) + 1200_000).toISOString();
  const metrics = await monitoring(ctx, f, start, end);
  const cost = await costReports(ctx, f, start, end);
  const complete = metrics.appCpuPct != null && metrics.dbCpuPct != null &&
    metrics.lbBandwidth.peakBitsPerSecond != null;
  if (!complete) {
    await updateAdapterState(ctx.statePath, (s) => { s.oci[identity.campaignId].fault = true; }, ctx.deps.fs || {});
  }
  return safeOci({ ok: complete, complete, cloud: 'oci', adapterVersion: ADAPTER_VERSION,
    ...identity, invented: false, ...raw, monitoring: metrics, cost, reconnects,
    saturated: raw.steady.totalLossPct > 1,
    ...(complete ? {} : { error: { code: 'COLLECT_INCOMPLETE', message: 'Required OCI Monitoring evidence missing' } }) });
}

export async function waitReadyOci(ctx, f) {
  const spec = getScenario('oci-holdout-10');
  assertConfiguration(f, spec, ctx.env);
  return safeOci({ ok: true, cloud: 'oci', ready: await checkReady(ctx, f), adapterVersion: ADAPTER_VERSION });
}

export async function teardownOciScenario() {
  // Holdout saturation never authorizes killing k6. Resource destroy belongs to
  // the separately authorized cleanup command, not interrupted-run teardown.
  return { ok: true, cloud: 'oci', teardown: { k6Stopped: false, detached: true } };
}

export function noLoadAcceptance() {
  // Pure catalog acceptance: deliberately has no ctx, dependencies or outputs.
  const history = [];
  return [10, 100, 500, 1000].map((rps) => {
    const spec = getScenario(`oci-holdout-${rps}`);
    const plan = resolveLadder(spec, {});
    const meta = assertLadderPosition(spec, plan, history);
    history.push({ rps });
    return { scenario: spec.key, script: `load/${spec.workload.script}`,
      SCENARIO: spec.workload.envValue, ...meta, noLoad: true, cloudCalls: 0 };
  });
}
