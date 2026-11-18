// Launcher-only trust preparation. No cloud, console, keyscan or SSH calls.
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { OCI_HOLDOUT_TEST_ID_RE } from './oci-catalog.mjs';

const fault = () => Object.assign(new Error('OCI_SSH_HOST_IDENTITY_INVALID'),
  { code: 'OCI_SSH_HOST_IDENTITY_INVALID' });

export function assertHostIdentityPlan(changes) {
  const expected = ['tls_private_key.app_host[0]', 'tls_private_key.app_host[1]',
    'tls_private_key.generator_host'];
  const actual = changes.filter(change => change.mode === 'managed' && change.type === 'tls_private_key');
  if (actual.length !== 3 || new Set(actual.map(change => change.address)).size !== 3 ||
      actual.some(change => !expected.includes(change.address) ||
        change.change?.actions?.join() !== 'create' ||
        change.change?.after?.algorithm !== 'ED25519')) throw fault();
}

function key(value) {
  if (typeof value !== 'string') throw fault();
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!match) throw fault();
  const bytes = Buffer.from(match[1], 'base64');
  // OpenSSH wire format: uint32(11), "ssh-ed25519", uint32(32), key.
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 ||
      bytes.subarray(4, 15).toString('ascii') !== 'ssh-ed25519' ||
      bytes.readUInt32BE(15) !== 32 || bytes.toString('base64') !== match[1]) throw fault();
  return `ssh-ed25519 ${match[1]}`;
}

export function knownHostsFromTerraform(output, testId) {
  if (!OCI_HOLDOUT_TEST_ID_RE.test(testId || '') || output?.oci?.sensitive !== true) throw fault();
  const f = output.oci.value;
  if (f?.test_id !== testId || f?.region !== 'us-ashburn-1' ||
      f?.compartment_name !== 'cwm-bench-oci' ||
      !Array.isArray(f.app_ips) || f.app_ips.length !== 2 ||
      !Array.isArray(f.ssh_host_identities) || f.ssh_host_identities.length !== 3) throw fault();
  const expected = new Map([['app-1', f.app_ips[0]], ['app-2', f.app_ips[1]],
    ['generator', f.generator_ip]]);
  const roles = new Set(), hosts = new Set(), keys = new Set(), lines = new Map();
  for (const identity of f.ssh_host_identities) {
    if (!identity || !expected.has(identity.role) || roles.has(identity.role) ||
        identity.host !== expected.get(identity.role) || typeof identity.host !== 'string' ||
        isIP(identity.host) !== 4 ||
        hosts.has(identity.host)) throw fault();
    const publicKey = key(identity.public_key);
    if (keys.has(publicKey)) throw fault();
    roles.add(identity.role); hosts.add(identity.host); keys.add(publicKey);
    lines.set(identity.role, `${identity.host} ${publicKey}\n`);
  }
  return [...expected.keys()].map(role => lines.get(role)).join('');
}

export async function writeKnownHosts(output, testId, destination) {
  // Validate the ENTIRE mapping before creating anything or replacing a file.
  const text = knownHostsFromTerraform(output, testId);
  const temporary = join(dirname(destination), `.known-hosts-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, destination);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { trustedHosts: 3, source: 'terraform-generated-per-instance-ed25519' };
}
