#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOciDeps } from './lib/adapter/oci-cli.mjs';
import { resolveMysqlVersion } from './lib/adapter/oci-mysql-version.mjs';

// Read-only pre-apply helper. Resolves terraform/oci mysql_version from
// `oci mysql version list` (newest 8.4.x, else newest 8.x). Never applies.
// The compartment OCID is runtime-only and is not written to the evidence.
export async function selectMysqlVersionCli({
  env = process.env, deps,
} = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = { env, deps: deps || createOciDeps(root, env) };
  const selection = await resolveMysqlVersion(ctx, env.CWM_OCI_COMPARTMENT_ID);
  return { ok: true, mocked: Boolean(deps), cloudCalls: 1, operation: 'mysql.version.list', ...selection };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selectMysqlVersionCli().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((err) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: { code: err.code || 'OCI_MYSQL_VERSION_UNAVAILABLE', message: err.message },
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
