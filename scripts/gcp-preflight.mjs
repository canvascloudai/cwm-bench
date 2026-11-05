#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultDeps, createProcessRunner } from './lib/adapter/exec.mjs';
import { gcpVmInventoryProbe } from './lib/adapter/gcp-cli.mjs';

// Availability only: no run/collect, no Terraform and no billed query.
export async function gcpPreflight({
  env = process.env, now = () => new Date(), runGcloud, runBq, probeVmInventory = gcpVmInventoryProbe,
} = {}) {
  const project = env.GOOGLE_CLOUD_PROJECT;
  const report = { ok: false, metadataOnly: true, billedQueryExecuted: false,
    measurementCollectionValidated: false, checks: [] };
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    report.checks.push({ name: 'project-variable', ok: false });
    return report;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const gcloud = runGcloud || createDefaultDeps(root, env).runGcloud;
  const bq = runBq || createProcessRunner('bq');
  async function check(name, runner, args, validate = () => true) {
    try {
      const result = await runner(args);
      report.checks.push({ name, ok: result.code === 0 && validate(result.stdout),
        exitCode: result.code });
    } catch {
      // SDK/CLI exceptions can contain credentials or private project details.
      report.checks.push({ name, ok: false, exitCode: null });
    }
  }
  await check('gcloud-command', gcloud, ['version', '--format=json']);
  await check('bq-standard-sql-api-dry-run', bq, [
    `--project_id=${project}`, '--format=json', 'query',
    '--use_legacy_sql=false', '--dry_run', 'SELECT 1',
  ]);
  await check('compute-instance-label-inventory-api', () => probeVmInventory({
    project, testId: env.CWM_CAMPAIGN_ID || 'gcp-fit-v1-preflight',
  }), [], (stdout) => {
    const inventory = JSON.parse(stdout);
    const valid = inventory.inventoryOnly === true &&
      ['app', 'generator'].every((role) => Number.isInteger(inventory.roleCounts?.[role]) &&
        inventory.roleCounts[role] >= 0);
    if (valid) report.inventoryRoleCounts = {
      app: inventory.roleCounts.app, generator: inventory.roleCounts.generator,
    };
    return valid;
  });
  const end = now();
  const start = new Date(end.getTime() - 5 * 60 * 1000);
  await check('monitoring-timeSeries.list-api', gcloud, [
    'monitoring', 'time-series', 'list', `--project=${project}`,
    '--filter=metric.type="compute.googleapis.com/instance/cpu/utilization"',
    `--interval-start-time=${start.toISOString()}`,
    `--interval-end-time=${end.toISOString()}`, '--format=json',
  ], (stdout) => Array.isArray(JSON.parse(stdout)));
  report.ok = report.checks.every((check) => check.ok);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  gcpPreflight().then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }).catch(() => {
    process.stderr.write('GCP availability preflight failed; no resources started.\n');
    process.exitCode = 1;
  });
}
