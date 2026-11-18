#!/usr/bin/env node
// Called by the controller AFTER authenticated Terraform output and BEFORE
// readiness, transfer or any other SSH connection. Never provisions resources.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeKnownHosts } from './lib/adapter/oci-host-identity.mjs';

const files = ['scripts/lib/adapter/oci-catalog.mjs',
  'scripts/lib/adapter/oci-host-identity.mjs', 'scripts/oci-pin-ssh-hosts.mjs'];

export async function hostIdentityControllerHash() {
  const manifest = [];
  for (const file of files) {
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    manifest.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { controllerHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), manifest };
}

export async function main(args) {
  const provenance = await hostIdentityControllerHash();
  if (args.length === 1 && args[0] === '--controller-hash') return provenance;
  const options = new Map();
  const allowed = new Set(['--terraform-output-file', '--test-id', '--known-hosts']);
  for (let n = 0; n < args.length; n += 2) {
    if (!allowed.has(args[n]) || options.has(args[n]) ||
        !args[n + 1] || args[n + 1].startsWith('--')) throw new Error('OCI_SSH_PIN_USAGE');
    options.set(args[n], args[n + 1]);
  }
  if (options.size !== 3) throw new Error('OCI_SSH_PIN_USAGE');
  const raw = await readFile(options.get('--terraform-output-file'));
  if (raw.length > 2 * 1024 * 1024) throw new Error('OCI_SSH_OUTPUT_TOO_LARGE');
  const result = await writeKnownHosts(JSON.parse(raw.toString('utf8')),
    options.get('--test-id'), options.get('--known-hosts'));
  return { ok: true, ...result, controllerHash: provenance.controllerHash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)))
    .catch(() => {
      // Do not expose malformed Terraform output, paths, IPs, public keys,
      // fingerprints or provider diagnostics.
      console.error(JSON.stringify({ ok: false, code: 'OCI_SSH_HOST_PIN_FAILED' }));
      process.exitCode = 1;
    });
}
