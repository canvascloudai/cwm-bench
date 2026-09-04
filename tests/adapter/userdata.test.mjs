import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEMPLATES = [
  'terraform/userdata/app.sh.tftpl',
  'terraform/userdata/generator.sh.tftpl',
];

const FORBIDDEN_FALLBACKS = [
  /git clone --depth 1 --branch/,
  /git clone --depth 1 "\$GIT_URL"/,
  /git clone --depth 1 '\$GIT_URL'/,
  /git checkout main\b/,
  /git checkout master\b/,
  /git checkout HEAD\b/,
  /git checkout origin\/main/,
  /git checkout origin\/master/,
  /fallback to main/,
  /\|\|\s*git clone --depth 1/,
];

for (const rel of TEMPLATES) {
  test(`${rel} requires exact URL + SHA and has no branch fallback`, () => {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /GIT_URL="\$\{git_url\}"/);
    assert.match(text, /GIT_REF="\$\{git_ref\}"/);
    assert.match(text, /FATAL: app_source_git_url and app_source_git_ref/);
    assert.match(text, /refusing to fall back to main, master, HEAD/);
    assert.match(text, /git ref must be an exact commit SHA/);
    assert.match(text, /git -C \/opt\/cwm-bench-src fetch --depth 1 origin "\$GIT_REF"/);
    assert.match(text, /checkout --detach FETCH_HEAD/);
    assert.match(text, /no fallback to default branch/);
    assert.match(text, /checked out \$ACTUAL_SHA but campaign required \$GIT_REF/);
    for (const pattern of FORBIDDEN_FALLBACKS) {
      assert.doesNotMatch(text, pattern, `${rel} matches forbidden fallback ${pattern}`);
    }
    assert.doesNotMatch(text, /git clone --branch "\$GIT_REF"/);
  });
}

test('terraform variables reject main/master/HEAD as app_source_git_ref', () => {
  const text = readFileSync(path.join(ROOT, 'terraform/variables.tf'), 'utf8');
  assert.match(text, /app_source_git_ref/);
  assert.match(text, /main, master, and HEAD are rejected/);
  assert.match(text, /\^\[0-9a-fA-F\]\{7,40\}\$/);
});

test('app bootstrap avoids full OS updates and retries transient setup steps', () => {
  const text = readFileSync(path.join(ROOT, 'terraform/userdata/app.sh.tftpl'), 'utf8');
  assert.doesNotMatch(text, /^dnf -y update$/m);
  assert.match(text, /retry 4 15 dnf -y install git python3 mariadb105 awscli-2/);
  assert.match(text, /retry 4 15 npm ci --omit=dev --ignore-scripts/);
  assert.match(text, /DB_READY=0/);
  assert.match(text, /RDS did not become reachable during app bootstrap/);
  assert.match(text, /seed_database\(\)/);
  assert.match(text, /retry 6 10 seed_database/);
});
