import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { assertOciHoldoutTestId } from './oci-catalog.mjs';
import { fault, ociJson, safeOci } from './oci-commands.mjs';

const allowedAddresses = new Set(JSON.parse(readFileSync(new URL('../../cleanup-compat.json', import.meta.url), 'utf8')).oci.resourceAddresses);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function ownedState(state, testId) {
  const ids = [];
  const localKeyRoles = new Set();
  const parents = {};
  for (const r of state.resources || []) {
    for (const i of r.instances || []) {
      if (r.mode !== 'data' && i.attributes?.freeform_tags?.test_id === testId) {
        (parents[r.type] ||= new Set()).add(i.attributes.id);
      }
    }
  }
  const children = {
    oci_load_balancer_backend_set: ['oci_load_balancer_load_balancer', 'load_balancer_id'],
    oci_load_balancer_backend: ['oci_load_balancer_load_balancer', 'load_balancer_id'],
    oci_load_balancer_listener: ['oci_load_balancer_load_balancer', 'load_balancer_id'],
    oci_budget_alert_rule: ['oci_budget_budget', 'budget_id'],
  };
  for (const r of state.resources || []) {
    if (r.mode === 'data') continue;
    if (!allowedAddresses.has(`${r.type}.${r.name}`)) throw fault('OCI_CLEANUP_UNOWNED_STATE');
    for (const instance of r.instances || []) {
      const a = instance.attributes || {};
      if (r.type === 'random_password') continue;
      if (r.type === 'tls_private_key') {
        // These are local provider state, never OCI resources or Search IDs.
        // Only the exact three identities introduced in adapter 1.9.3 qualify.
        const role = r.name === 'app_host' && [0, 1].includes(instance.index_key)
          ? `app-${instance.index_key}` : r.name === 'generator_host' &&
            instance.index_key == null ? 'generator' : null;
        if (r.mode !== 'managed' || r.provider !== 'provider["registry.terraform.io/hashicorp/tls"]' ||
            !role || localKeyRoles.has(role) || a.algorithm !== 'ED25519')
          throw fault('OCI_CLEANUP_UNOWNED_STATE');
        localKeyRoles.add(role);
        continue;
      }
      // No arbitrary addresses or untagged provider resources may enter destroy.
      const parent = children[r.type];
      const owned = parent ? parents[parent[0]]?.has(a[parent[1]]) : a.freeform_tags?.test_id === testId;
      if (!r.type.startsWith('oci_') || !owned) throw fault('OCI_CLEANUP_UNOWNED_STATE');
      ids.push(a.id);
      if (a.boot_volume_id) ids.push(a.boot_volume_id);
    }
  }
  return ids.filter(Boolean).sort();
}

export async function makeManifest(ctx, f, variableFile) {
  const r = await ctx.deps.runOciTerraform(['state', 'pull']);
  if (r.code !== 0) throw fault('OCI_CLEANUP_STATE_MISSING');
  const state = JSON.parse(r.stdout);
  const bytes = await readFile(variableFile);
  let variables;
  try { variables = JSON.parse(bytes); } catch { throw fault('OCI_CLEANUP_REQUIRES_TFVARS_JSON'); }
  // A failed partial apply may have no Terraform outputs yet. Bind directly
  // to its complete runtime variables and actual partial state, not guessed
  // future resource IDs. Search still inventories its entire compartment.
  if (!f) {
    const target = await ociJson(ctx, ['iam', 'compartment', 'get', '--compartment-id', variables.compartment_id]);
    if (target.name !== 'cwm-bench-oci') throw fault('OCI_CLEANUP_COMPARTMENT');
    const database = (state.resources || []).find((r) => r.type === 'oci_mysql_mysql_db_system' && r.name === 'main');
    f = { test_id: variables.test_id, compartment_id: variables.compartment_id,
      availability_domain: variables.availability_domain, measurement_sha: variables.measurement_sha,
      db_id: database?.instances?.[0]?.attributes?.id || null };
  }
  assertOciHoldoutTestId({ cloud: 'oci', key: 'cleanup' }, f.test_id);
  const required = ['compartment_id', 'tenancy_id', 'availability_domain', 'image_id',
    'ssh_public_key', 'controller_cidr', 'budget_recipients', 'test_id', 'measurement_sha'];
  if (required.some((k) => !variables[k]) || variables.compartment_id !== f.compartment_id ||
      variables.test_id !== f.test_id || variables.availability_domain !== f.availability_domain ||
      variables.measurement_sha !== f.measurement_sha) throw fault('OCI_CLEANUP_VARIABLE_DRIFT');
  return { testId: f.test_id, compartmentId: f.compartment_id,
    lineage: state.lineage, variableFile, variableSha256: digest(bytes),
    resourceIds: ownedState(state, f.test_id), dbId: f.db_id,
    createdAt: ctx.now().toISOString() };
}

export async function searchSweep(ctx, manifest) {
  const compartment = manifest.compartmentId;
  if (!/^[a-zA-Z0-9._-]+$/.test(compartment || '')) throw fault('OCI_COMPARTMENT_INVALID');
  // Search the entire named compartment, not only tag-filtered rows: untagged
  // residuals must still be visible. Search is inventory only; never deletion.
  const response = await ociJson(ctx, ['search', 'resource', 'structured-search',
    '--query-text', `query all resources where compartmentId = '${compartment}'`, '--all']);
  if (!Array.isArray(response?.items)) throw fault('OCI_SEARCH_INVENTORY_INVALID');
  const rows = response.items;
  // Retain every returned resource type, including future Search spellings.
  // Filtering to a hardcoded MySQL spelling could hide billable residuals.
  return rows.map((r) => ({
    type: r['resource-type'], id: r.identifier, state: r['lifecycle-state'],
    owned: manifest.resourceIds.includes(r.identifier) || r['freeform-tags']?.test_id === manifest.testId,
  }));
}

export async function cleanup(ctx, manifest, phase) {
  assertOciHoldoutTestId({ cloud: 'oci', key: 'cleanup' }, manifest.testId);
  if (!['immediate', '24h'].includes(phase)) throw fault('OCI_CLEANUP_PHASE');
  if (digest(await readFile(manifest.variableFile)) !== manifest.variableSha256) throw fault('OCI_CLEANUP_VARIABLE_DRIFT');
  const now = ctx.now();
  const persist = ctx.deps.persistOciManifest;
  if (typeof persist !== 'function') throw fault('OCI_CLEANUP_PERSISTENCE_REQUIRED');
  const retryAt = () => new Date(now.getTime() + 2 * 3600_000).toISOString();
  const firstDestroyAt = manifest.firstDestroyAt || manifest.destroyedAt;
  if (phase === '24h' && (!firstDestroyAt ||
      now.getTime() < Date.parse(firstDestroyAt) + 24 * 3600_000)) throw fault('OCI_CLEANUP_TOO_EARLY');
  if (phase === 'immediate') {
    manifest.firstDestroyAt ||= now.toISOString();
    manifest.lastDestroyAttemptAt = now.toISOString();
    manifest.lastDestroyOk = false;
    manifest.terraformStateEmpty = null;
    manifest.nextDestroyRetryAt = retryAt();
    // Commit intent before dispatch. An interrupted destroy, failed inventory,
    // or killed controller must not erase the 24h clock or two-hour retry.
    await persist(manifest);
    const pulled = await ctx.deps.runOciTerraform(['state', 'pull']);
    if (pulled.code !== 0) throw fault('OCI_CLEANUP_STATE_MISSING');
    const state = JSON.parse(pulled.stdout);
    if (state.lineage !== manifest.lineage) throw fault('OCI_CLEANUP_LINEAGE');
    const ids = ownedState(state, manifest.testId);
    if (ids.some((id) => !manifest.resourceIds.includes(id))) throw fault('OCI_CLEANUP_UNOWNED_STATE');
    try {
      const r = await ctx.deps.runOciTerraform(['destroy', '-input=false', '-auto-approve',
        `-var-file=${manifest.variableFile}`], { timeoutMs: 2 * 3600_000 });
      manifest.lastDestroyOk = r.code === 0;
      if (r.code === 0) manifest.destroyedAt ||= now.toISOString();
    } catch {
      manifest.lastDestroyOk = false;
    }
    // Persist the destroy result before every fallible read below.
    await persist(manifest);
    try {
      const remaining = await ctx.deps.runOciTerraform(['state', 'pull']);
      const after = remaining.code === 0 ? JSON.parse(remaining.stdout) : null;
      // Resource Search cannot see tenancy-scoped budgets. Empty Terraform
      // state is an independent requirement covering budgets and their rules.
      manifest.terraformStateEmpty = after?.lineage === manifest.lineage && Array.isArray(after.resources)
        ? !after.resources.some((r) => r.mode !== 'data' && r.instances?.length)
        : null;
    } catch {
      manifest.terraformStateEmpty = null;
    }
    await persist(manifest);
  }
  let residuals = [], searchOk = true;
  try { residuals = await searchSweep(ctx, manifest); }
  catch { searchOk = false; }
  const owned = residuals.filter((r) => r.owned && !['TERMINATED', 'DELETED'].includes(r.state));
  const inventoryClean = searchOk && owned.length === 0 &&
    manifest.lastDestroyOk === true && manifest.terraformStateEmpty === true;
  manifest.nextDestroyRetryAt = inventoryClean ? null : retryAt();
  manifest.lastSearchOk = searchOk;
  // Inventory failure is inconclusive, never a clean sweep.
  await persist(manifest);
  let backups = null, stoppedCharges = null;
  if (phase === '24h') {
    try {
      if (!manifest.dbId) {
        backups = []; // partial apply never created a DB system
      } else {
      backups = await ociJson(ctx, ['mysql', 'backup', 'list', '--compartment-id', manifest.compartmentId,
        '--db-system-id', manifest.dbId, '--all']);
      }
    } catch { backups = null; }
    // Cost Analysis is supporting evidence, never a made-up zero. Even an
    // empty result does not establish coverage or prove that charging stopped.
    try {
      const usage = await ociJson(ctx, ['usage-api', 'usage-summary', 'request-summarized-usages',
        '--tenant-id', ctx.env.CWM_OCI_TENANCY_ID,
        '--time-usage-started', new Date(Math.ceil((Date.parse(manifest.destroyedAt || firstDestroyAt) + 3600_000) / 3600_000) * 3600_000).toISOString(),
        '--time-usage-ended', now.toISOString(), '--granularity', 'HOURLY',
        '--query-type', 'COST', '--group-by', '["resourceId"]']);
      const rows = (usage?.items || []).filter((r) => manifest.resourceIds.includes(r['resource-id']));
      const coveredAmounts = rows.length > 0 && rows.every((r) =>
        r['computed-amount'] != null && Number.isFinite(Number(r['computed-amount'])));
      stoppedCharges = { verified: false, source: 'OCI Cost Analysis',
        observedCost: coveredAmounts ? rows.reduce((s, r) => s + Number(r['computed-amount']), 0) : null,
        reason: 'Coverage must be reconciled with delayed cost reports; absence is not zero' };
    } catch { stoppedCharges = { verified: false, observedCost: null, source: 'unavailable' }; }
  }
  return { manifest, report: safeOci({ testId: manifest.testId, phase, at: now.toISOString(),
    destroyOk: manifest.lastDestroyOk ?? null, residuals: searchOk ? residuals : null,
    searchOk, terraformStateEmpty: manifest.terraformStateEmpty ?? null,
    ownedRemaining: searchOk ? owned.length : null,
    backups: backups == null ? null : backups.map((b) => ({ id: b.id, state: b['lifecycle-state'] })),
    stoppedCharges, inventoryClean,
    nextDestroyRetryAt: manifest.nextDestroyRetryAt,
    delayedSweepAt: manifest.firstDestroyAt ? new Date(Date.parse(manifest.firstDestroyAt) + 24 * 3600_000).toISOString() : null,
    ask: Boolean(!inventoryClean && (manifest.firstDestroyAt || manifest.destroyedAt) &&
      now.getTime() - Date.parse(manifest.firstDestroyAt || manifest.destroyedAt) >= 24 * 3600_000),
    unrelatedDeletionAllowed: false }) };
}
