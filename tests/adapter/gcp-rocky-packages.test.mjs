import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = readFileSync(path.join(root, 'terraform/gcp/userdata/app.sh.tftpl'), 'utf8');
const generator = readFileSync(path.join(root, 'terraform/gcp/userdata/generator.sh.tftpl'), 'utf8');

// Offline package-name compatibility fixture, not an on-image DNF reproduction.
const rockyDnf = `
retry() { shift 2; "$@"; }
dnf() {
  test "$1" = -y && test "$2" = install || return 2
  shift 2
  for package in "$@"; do
    case "$package" in
      git|python3|mariadb|tar|gzip) ;;
      *) printf 'No match for argument: %s\\n' "$package" >&2; return 1 ;;
    esac
  done
}
`;
const run = command => spawnSync('bash', ['-eu', '-c', rockyDnf + '\n' + command],
  { encoding: 'utf8' });

test('GCP app initial install uses the Rocky Linux mariadb client name', () => {
  const command = app.match(/^retry 4 15 dnf -y install .+$/m)?.[0];
  assert.ok(command);
  assert.equal(command, 'retry 4 15 dnf -y install git python3 mariadb');
  assert.equal(run(command).status, 0);
});

test('the old Amazon Linux mariadb105 command fails the Rocky package fixture', () => {
  const result = run('retry 4 15 dnf -y install git python3 mariadb105');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No match for argument: mariadb105/);
});

test('the GCP generator initial package install remains Rocky-compatible', () => {
  const command = generator.match(/^dnf -y install .+$/m)?.[0];
  assert.ok(command);
  assert.equal(run(command).status, 0);
  assert.doesNotMatch(command, /\b(?:mariadb105|awscli-2|amazon-linux-extras)\b/);
});
