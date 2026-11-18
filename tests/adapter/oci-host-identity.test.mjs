import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { knownHostsFromTerraform, writeKnownHosts, assertHostIdentityPlan } from '../../scripts/lib/adapter/oci-host-identity.mjs';
import { main, hostIdentityControllerHash } from '../../scripts/oci-pin-ssh-hosts.mjs';
import { ssh } from '../../scripts/lib/adapter/oci-commands.mjs';

const id = 'oci-holdout-v1-r1-ad1-20261120';
const script = new URL('../../scripts/oci-pin-ssh-hosts.mjs', import.meta.url);
function fixture() {
  // Ephemeral offline keys; never source defaults, committed keys or credentials.
  const identities = ['app-1', 'app-2', 'generator'].map((role, n) => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const wire = Buffer.alloc(51);
    wire.writeUInt32BE(11, 0); wire.write('ssh-ed25519', 4);
    wire.writeUInt32BE(32, 15); raw.copy(wire, 19);
    return { role, host: `192.0.2.${n + 1}`, public_key: `ssh-ed25519 ${wire.toString('base64')}` };
  });
  return { oci: { sensitive: true, value: {
    test_id: id, region: 'us-ashburn-1', compartment_name: 'cwm-bench-oci',
    app_ips: identities.slice(0, 2).map(x => x.host), generator_ip: identities[2].host,
    ssh_host_identities: identities,
  } } };
}
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cwm-host-pin-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('pins all three distinct hosts directly from Terraform, independent of output order', () => {
  const output = fixture(), expected = output.oci.value.ssh_host_identities
    .map(x => `${x.host} ${x.public_key}\n`).join('');
  output.oci.value.ssh_host_identities.reverse();
  assert.equal(knownHostsFromTerraform(output, id), expected);
});

test('malformed, missing, cross-apply, duplicate and injected identities fail closed', () => {
  const mutations = [
    o => { delete o.oci.value.ssh_host_identities; },
    o => { o.oci.sensitive = false; },
    o => { o.oci.value.test_id = id.replace('r1', 'r2'); },
    o => { o.oci.value.region = 'other'; },
    o => { o.oci.value.compartment_name = 'unrelated'; },
    o => { o.oci.value.ssh_host_identities.pop(); },
    o => { o.oci.value.ssh_host_identities[0].role = 'generator'; },
    o => { o.oci.value.ssh_host_identities[0].host = '192.0.2.90'; },
    o => { o.oci.value.ssh_host_identities[0].host = '192.0.2.1\n*'; },
    o => { o.oci.value.ssh_host_identities[0].public_key += '\n* ssh-ed25519 injected'; },
    o => { o.oci.value.ssh_host_identities[0].public_key = 'ssh-ed25519 YWJj'; },
    o => { o.oci.value.ssh_host_identities[0].public_key = 'ssh-rsa YWJj'; },
    o => { o.oci.value.ssh_host_identities[1].public_key = o.oci.value.ssh_host_identities[0].public_key; },
    o => { o.oci.value.app_ips[1] = o.oci.value.app_ips[0];
      o.oci.value.ssh_host_identities[1].host = o.oci.value.app_ips[0]; },
  ];
  for (const mutate of mutations) {
    const output = fixture(); mutate(output);
    assert.throws(() => knownHostsFromTerraform(output, id), { code: 'OCI_SSH_HOST_IDENTITY_INVALID' });
  }
});

test('atomic private file is ready before the first strict SSH connection, including reconnects', () =>
  temporary(async dir => {
    const output = fixture(), known = join(dir, 'known-hosts');
    await writeKnownHosts(output, id, known);
    assert.equal((await stat(known)).mode & 0o777, 0o600);
    let calls = 0;
    await ssh({ env: { CWM_OCI_SSH_KEY: 'offline-client-key', CWM_OCI_KNOWN_HOSTS: known },
      deps: { wait: async () => {}, nowMs: () => 0, runOciSsh: async args => {
        assert.equal(await readFile(known, 'utf8'), knownHostsFromTerraform(output, id));
        assert.ok(args.includes('-oStrictHostKeyChecking=yes'));
        assert.ok(args.includes(`-oUserKnownHostsFile=${known}`));
        return ++calls === 1 ? { code: 255 } : { code: 0, stdout: 'ready' };
      } } }, '192.0.2.1', 'true');
    assert.equal(calls, 2);
  }));

test('invalid output never truncates a trusted existing file or leaves partial files', () =>
  temporary(async dir => {
    const known = join(dir, 'known-hosts');
    await writeFile(known, 'original');
    await assert.rejects(writeKnownHosts({}, id, known));
    assert.equal(await readFile(known, 'utf8'), 'original');
    assert.deepEqual(await readdir(dir), ['known-hosts']);
  }));

test('atomic replacement does not follow a destination symlink or append stale keys', () =>
  temporary(async dir => {
    const target = join(dir, 'untouched'), known = join(dir, 'known-hosts'), output = fixture();
    await writeFile(target, 'original');
    await symlink(target, known);
    await writeKnownHosts(output, id, known);
    assert.equal(await readFile(target, 'utf8'), 'original');
    assert.equal(await readFile(known, 'utf8'), knownHostsFromTerraform(output, id));
    const next = fixture();
    await writeKnownHosts(next, id, known);
    assert.equal(await readFile(known, 'utf8'), knownHostsFromTerraform(next, id));
  }));

test('CLI writes known_hosts and emits provenance without exposing host keys or addresses', () =>
  temporary(async dir => {
    const output = fixture(), file = join(dir, 'output.json'), known = join(dir, 'known-hosts');
    await writeFile(file, JSON.stringify(output));
    const result = await main(['--test-id', id, '--terraform-output-file', file, '--known-hosts', known]);
    assert.equal(result.trustedHosts, 3);
    assert.match(result.controllerHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /192\.0\.2|ssh-ed25519|BEGIN|fingerprint/i);
    assert.equal(await readFile(known, 'utf8'), knownHostsFromTerraform(output, id));
    const failed = spawnSync(process.execPath, [script.pathname, '--test-id', id,
      '--terraform-output-file', file, '--known-hosts', known, '--test-id', id], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.deepEqual(JSON.parse(failed.stderr), { ok: false, code: 'OCI_SSH_HOST_PIN_FAILED' });
  }));

test('controller hash binds exact launcher and transitive local trust-source bytes', async () => {
  const provenance = await hostIdentityControllerHash();
  for (const row of provenance.manifest) {
    const bytes = await readFile(new URL(`../../${row.file}`, import.meta.url));
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(provenance.controllerHash,
    createHash('sha256').update(JSON.stringify(provenance.manifest)).digest('hex'));
  assert.deepEqual(await main(['--controller-hash']), provenance);
});

test('trust launcher has no console, scan, network or SSH command dependency', async () => {
  const text = await readFile(new URL('../../scripts/lib/adapter/oci-host-identity.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /child_process|execFile|spawn\(|captureConsoleHistory|runOci|fetch\(/);
});

test('plan admits only the three distinct create-only Ed25519 host-key resources', () => {
  const changes = ['tls_private_key.app_host[0]', 'tls_private_key.app_host[1]',
    'tls_private_key.generator_host'].map(address => ({ address, mode: 'managed', type: 'tls_private_key',
      change: { actions: ['create'], after: { algorithm: 'ED25519' } } }));
  assertHostIdentityPlan(changes);
  for (const mutate of [
    x => x.pop(),
    x => x.push(structuredClone(x[0])),
    x => { x[0].address = 'tls_private_key.unexpected'; },
    x => { x[0].change.actions = ['delete', 'create']; },
    x => { x[0].change.after.algorithm = 'RSA'; },
    x => { x[0].address = x[1].address; },
  ]) {
    const invalid = structuredClone(changes); mutate(invalid);
    assert.throws(() => assertHostIdentityPlan(invalid), { code: 'OCI_SSH_HOST_IDENTITY_INVALID' });
  }
});
