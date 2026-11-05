import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVmCpuSelector, listLabeledVms, rawVmCpuFilter, assertSelectedVmSeries } from './gcp-vm-selector.mjs';

const execFileAsync = promisify(execFile);

// Tokens remain inside this transport. Never pass them through a runner that
// redacts stdout, and never include auth output in errors or run documents.
async function accessToken(project) {
  const result = await execFileAsync('gcloud', [
    'auth', 'print-access-token', `--project=${project}`, '--quiet',
  ], { timeout: 30000, maxBuffer: 65536 });
  const token = result.stdout.trim();
  if (!/^[A-Za-z0-9._~+/-]{20,8192}={0,2}$/.test(token)) {
    throw new Error('Invalid authentication output');
  }
  return token;
}

function flag(args, name) {
  const values = args.filter((arg) => arg.startsWith(`${name}=`));
  if (values.length !== 1) throw new Error('Missing or duplicate transport flag');
  return values[0].slice(name.length + 1);
}

// Preserve the collector's existing dependency contract. Only these two
// nonexistent CLI routes are translated; SSH and all other gcloud calls pass
// through unchanged. Only the explicitly approved VM label selector is resolved
// to raw instance-ID predicates. SQL, windows, points and calculations stay intact.
export function createGcpCliRunner({
  runGcloud, runBq, getAccessToken = accessToken, fetchFn = globalThis.fetch,
}) {
  return async function run(args) {
    if (args[0] === 'bigquery' && args[1] === 'query') {
      try {
        if (args.length !== 6 || args[2] !== '--use_legacy_sql=false' ||
            args[3] !== '--format=json' || !args[4].startsWith('--project=')) {
          throw new Error('Unexpected BigQuery transport arguments');
        }
        return await runBq([
          `--project_id=${flag(args, '--project')}`, '--format=json',
          'query', '--use_legacy_sql=false', args[5],
        ]);
      } catch {
        return { code: 1, stdout: '', stderr: 'BigQuery transport failed' };
      }
    }
    if (args[0] !== 'monitoring' || args[1] !== 'time-series' || args[2] !== 'list') {
      return runGcloud(args);
    }
    let project, filter, start, end;
    try {
      if (args.length !== 8 || !args.includes('--format=json')) {
        throw new Error('Unexpected Monitoring transport arguments');
      }
      project = flag(args, '--project');
      filter = flag(args, '--filter');
      start = flag(args, '--interval-start-time');
      end = flag(args, '--interval-end-time');
    } catch {
      return { code: 1, stdout: '', stderr: 'Invalid Cloud Monitoring transport arguments' };
    }
    let token;
    try { token = await getAccessToken(project); }
    catch {
      return { code: 1, stdout: '', stderr: 'Cloud Monitoring authentication failed' };
    }
    let selectedVms;
    try {
      const selector = parseVmCpuSelector(filter);
      if (selector) {
        selectedVms = await listLabeledVms({ project, ...selector, token, fetchFn });
        // Current inventory cannot safely recover historical IDs after a MIG
        // replacement inside the measurement window. Do not silently omit them.
        if (selectedVms.some((vm) => Date.parse(vm.createdAt) > Date.parse(start))) {
          throw new Error('VM roster changed inside the measurement window');
        }
        filter = rawVmCpuFilter(selectedVms);
      }
    } catch {
      return { code: 1, stdout: '', stderr: 'Cloud Monitoring VM selection failed' };
    }
    const series = [];
    const seenPages = new Set();
    let pageToken;
    do {
      const url = new URL(
        `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries`,
      );
      url.searchParams.set('filter', filter);
      url.searchParams.set('interval.startTime', start);
      url.searchParams.set('interval.endTime', end);
      url.searchParams.set('view', 'FULL');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response;
      try {
        response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        return { code: 1, stdout: '', stderr: 'Cloud Monitoring network request failed' };
      }
      let body;
      try { body = await response.json(); }
      catch {
        return { code: 1, stdout: '', stderr: 'Cloud Monitoring returned invalid JSON' };
      }
      if (!response.ok) {
        const status = Number.isInteger(response.status) ? response.status : 'unknown';
        const reason = /^[A-Z_]+$/.test(body?.error?.status || '') ? body.error.status : 'REQUEST_FAILED';
        return { code: 1, stdout: '', stderr: `Cloud Monitoring API failed: HTTP ${status} ${reason}` };
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          (body.timeSeries !== undefined && !Array.isArray(body.timeSeries)) ||
          (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string')) {
        return { code: 1, stdout: '', stderr: 'Cloud Monitoring returned an invalid time-series response' };
      }
      if (selectedVms) {
        try { assertSelectedVmSeries(body.timeSeries || [], selectedVms, project); }
        catch {
          return { code: 1, stdout: '', stderr: 'Cloud Monitoring VM series identity mismatch' };
        }
      }
      series.push(...(body.timeSeries || []));
      pageToken = body.nextPageToken;
      if (pageToken) {
        if (seenPages.has(pageToken)) {
          return { code: 1, stdout: '', stderr: 'Cloud Monitoring repeated a page token' };
        }
        seenPages.add(pageToken);
      }
    } while (pageToken);
    return { code: 0, stdout: JSON.stringify(series), stderr: '' };
  };
}

// Pre-apply capability check only. Zero matching VMs is legitimate before apply,
// but is never accepted by the measurement collection path above.
export async function gcpVmInventoryProbe({
  project, testId, getAccessToken = accessToken, fetchFn = globalThis.fetch,
}) {
  try {
    const token = await getAccessToken(project);
    const roleCounts = {};
    for (const role of ['app', 'generator']) {
      roleCounts[role] = (await listLabeledVms({
        project, role, testId, token, fetchFn, allowEmpty: true,
      })).length;
    }
    return { code: 0, stdout: JSON.stringify({ roleCounts, inventoryOnly: true }), stderr: '' };
  } catch {
    return { code: 1, stdout: '', stderr: 'Compute VM inventory availability check failed' };
  }
}
