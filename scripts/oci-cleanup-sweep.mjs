#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createContext } from './lib/adapter/main.mjs';
import { cleanup, makeManifest } from './lib/adapter/oci-cleanup.mjs';

// Manifest and Terraform state are private runner inputs, never archive them.
// prepare: node scripts/oci-cleanup-sweep.mjs prepare PRIVATE_MANIFEST PRIVATE_VARS
// destroy + sweep: ... immediate PRIVATE_MANIFEST
// inventory only:  ... 24h PRIVATE_MANIFEST
const [phase, file, variables] = process.argv.slice(2);
try {
  if (!file) throw new Error('missing manifest path');
  const ctx = createContext();
  ctx.deps.persistOciManifest = async (manifest) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 });
    await rename(temporary, file);
  };
  if (phase === 'prepare') {
    if (!variables) throw new Error('missing exact apply variables file');
    const manifest = await makeManifest(ctx, null, variables);
    await writeFile(file, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ ok: true, prepared: true }));
  } else {
    const result = await cleanup(ctx, JSON.parse(await readFile(file, 'utf8')), phase);
    console.log(JSON.stringify(result.report));
    if (!result.report.inventoryClean || !result.report.destroyOk) process.exitCode = 1;
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: e.code || 'OCI_CLEANUP_FAILED' }));
  process.exitCode = 1;
}
