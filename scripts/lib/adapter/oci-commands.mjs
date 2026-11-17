import { readFileSync } from 'node:fs';
import { redact } from './redact.mjs';

export const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
export function fault(code, message = code) {
  return Object.assign(new Error(message), { code, faultClass: 'runner', replaceable: true });
}
const waitDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ociJson(ctx, args) {
  for (let n = 0; n < 4; n++) {
    const r = await ctx.deps.runOci([...args, '--region', 'us-ashburn-1', '--output', 'json']);
    if (r.code === 0) {
      try { return JSON.parse(r.stdout || '{}').data; }
      catch { throw fault('OCI_JSON_INVALID'); }
    }
    if (n === 3 || !/429|5\d\d|throttl|timed? ?out|temporar|reset/i.test(r.stderr || '')) {
      // Never forward arbitrary CLI output; it may contain signed requests.
      throw fault('OCI_API_FAILED', 'OCI read failed; private command receipt retained by the runner');
    }
    await (ctx.deps.wait || waitDefault)([1000, 3000, 9000][n]);
  }
}

export async function ssh(ctx, host, script, { retry = true, evidence = [] } = {}) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host || '') ||
      !ctx.env.CWM_OCI_SSH_KEY || !ctx.env.CWM_OCI_KNOWN_HOSTS) throw fault('OCI_SSH_CONFIG');
  // Known hosts must be populated by the trusted controller, never ssh-keyscan
  // trust-on-first-use inside measurement code.
  const args = ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
    `-oUserKnownHostsFile=${ctx.env.CWM_OCI_KNOWN_HOSTS}`, '-oConnectTimeout=15',
    '-oServerAliveInterval=15', '-oServerAliveCountMax=2',
    '-i', ctx.env.CWM_OCI_SSH_KEY, `opc@${host}`, 'sudo', '-n', 'bash', '-s'];
  const now = ctx.deps.nowMs || Date.now;
  const deadline = now() + 600_000;
  for (let n = 0; n < 25; n++) {
    const r = await ctx.deps.runOciSsh(args, { input: script, timeoutMs: 60_000 });
    if (r.code === 0) return r.stdout;
    // Only SSH/control timeouts retry. A remote command failure is not a drop.
    if (!retry || ![255, 124].includes(r.code) || now() >= deadline) throw fault('OCI_SSH_FAILED');
    evidence.push({ at: new Date(now()).toISOString(), attempt: n + 1, code: r.code });
    await (ctx.deps.wait || waitDefault)(Math.min(30_000, 1000 * 2 ** Math.min(n, 5)));
  }
  throw fault('OCI_RECONNECT_EXHAUSTED');
}

export function runDirectory(identity) {
  // requireRunIdentity is deliberately stricter here: identities become paths
  // and systemd names; colons and dot segments are not accepted.
  for (const id of [identity.campaignId, identity.runId, identity.scenario]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id || '')) throw fault('RUN_IDENTITY_INVALID');
  }
  return `/opt/cwm-bench/results/raw/${identity.campaignId}/${identity.runId}`;
}

export function launchCommand(fields, identity) {
  const dir = runDirectory(identity);
  const marker = { ...identity, measurementSha: fields.measurement_sha };
  const supervisor = [
    'set -uo pipefail', 'umask 077', `cd ${quote(dir)}`,
    `export TARGET=${quote(fields.target)} SCENARIO=${quote(identity.scenario)}`,
    `export CAMPAIGN_ID=${quote(identity.campaignId)} RUN_ID=${quote(identity.runId)} SPLIT=holdout`,
    'export WARMUP=300s DURATION=900s RESULTS_DIR=.',
    // Start timestamp is on the generator. Completion is an atomic marker,
    // written only after compression. A controller disconnect cannot kill it.
    `python3 - <<'PY'\nimport json, datetime\nx=${JSON.stringify(marker)}\nx["startedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat()\nopen("identity.json","w").write(json.dumps(x))\nPY`,
    'set +e',
    '/usr/local/bin/k6 run --out json=k6.json --summary-export=summary.json /opt/cwm-source/load/oci-holdout.js >k6.log 2>&1',
    'code=$?', 'set -e', 'gzip -f k6.json',
    `python3 - "$code" <<'PY'\nimport json, datetime, sys, os\nx=json.load(open("identity.json"))\nx.update(exitCode=int(sys.argv[1]), endedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())\nopen("complete.tmp","w").write(json.dumps(x))\nos.rename("complete.tmp","complete.json")\nPY`,
  ].join('\n');
  // Atomic mkdir is the run-once guard. Existing directory means reattach;
  // even an interrupted launch must never silently rerun a rung.
  return [
    'set -euo pipefail', 'umask 077',
    `mkdir -p ${quote(dir.slice(0, dir.lastIndexOf('/')))}`,
    `if mkdir ${quote(dir)}; then`,
    `printf %s ${quote(supervisor)} >${quote(`${dir}/supervisor.sh`)}`,
    `systemd-run --unit=${quote(`cwm-${identity.campaignId}-${identity.runId}`)} --collect /bin/bash ${quote(`${dir}/supervisor.sh`)}`,
    `else test -d ${quote(dir)}; fi`,
  ].join('\n');
}

export function collectCommand(identity) {
  const dir = runDirectory(identity);
  const parser = readFileSync(new URL('./oci-raw.py', import.meta.url), 'utf8');
  return `set -euo pipefail\ncd ${quote(dir)}\npython3 - k6.json.gz complete.json <<'OCI_RAW_PY'\n${parser}\nOCI_RAW_PY`;
}

export function safeOci(value) {
  // Apply only at the outward boundary, after API parsing and attribution.
  return JSON.parse(redact(JSON.stringify(value)));
}
