import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PINNED_CLEANUP_REVISION } from '../../scripts/lib/adapter/version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

test('pinned cleanup revision is still fetchable locally', () => {
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'scripts/cleanup-compat.json'), 'utf8'));
  assert.equal(spec.pinnedCleanupRevision, PINNED_CLEANUP_REVISION);
  assert.equal(PINNED_CLEANUP_REVISION, 'e95c5319b5c7b9cbd934735241b355df4144cab0');

  const type = git(['cat-file', '-t', PINNED_CLEANUP_REVISION]);
  assert.equal(type, 'commit');

  const ancestor = git(['merge-base', '--is-ancestor', PINNED_CLEANUP_REVISION, 'HEAD']);
  assert.equal(ancestor, '');
});

test('pinned cleanup revision is reachable from origin when origin exists', () => {
  let remotes = '';
  try {
    remotes = git(['remote']);
  } catch {
    remotes = '';
  }
  if (!remotes.split('\n').includes('origin')) {
    return;
  }
  const fetched = git(['cat-file', '-t', PINNED_CLEANUP_REVISION]);
  assert.equal(fetched, 'commit');
});

test('Terraform resource addresses from the cleanup pin are still present', () => {
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'scripts/cleanup-compat.json'), 'utf8'));
  const tfFiles = readdirSync(path.join(ROOT, 'terraform'))
    .filter((name) => name.endsWith('.tf'))
    .map((name) => readFileSync(path.join(ROOT, 'terraform', name), 'utf8'))
    .join('\n');

  for (const address of spec.resourceAddresses) {
    const [type, name] = address.split('.');
    const pattern = new RegExp(`resource\\s+"${type}"\\s+"${name}"`);
    assert.match(tfFiles, pattern, `missing resource address ${address}`);
  }

  for (const required of ['aws_lb.main', 'aws_instance.app', 'aws_instance.generator', 'aws_db_instance.main']) {
    assert.ok(spec.resourceAddresses.includes(required), `compat list omitted ${required}`);
  }
});
