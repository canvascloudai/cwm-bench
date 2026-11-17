import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ociJson } from './oci-commands.mjs';

export function summarizeMetric(series, start, end) {
  const lo = Date.parse(start), hi = Date.parse(end);
  const points = (series || []).flatMap((s) => s['aggregated-datapoints'] || [])
    .filter((p) => {
      const t = Date.parse(p.timestamp);
      return t >= lo && t + 60_000 <= hi && Number.isFinite(p.value);
    });
  return points.length ? {
    avg: points.reduce((s, p) => s + p.value, 0) / points.length,
    max: Math.max(...points.map((p) => p.value)), count: points.length,
  } : { avg: null, max: null, count: 0 };
}

export async function monitoring(ctx, f, start, end) {
  const failures = [], metrics = {};
  const queries = [
    ...f.app_ids.map((id, n) => [`appCpu${n}`, 'oci_computeagent', 'CpuUtilization', 'resourceId', id]),
    ['dbCpu', 'oci_mysql_database', 'CPUUtilization', 'resourceId', f.db_id],
    ['dbConnections', 'oci_mysql_database', 'CurrentConnections', 'resourceId', f.db_id],
    ['lbBandwidth', 'oci_lbaas', 'peakBandwidth', 'resourceId', f.lb_id],
    ['lbSent', 'oci_lbaas', 'bytesSent', 'resourceId', f.lb_id],
    ['lbReceived', 'oci_lbaas', 'bytesReceived', 'resourceId', f.lb_id],
  ];
  for (const [label, namespace, metric, configuredDimension, id] of queries) {
    // IDs are API-supplied, never interpolated into shell commands.
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('invalid resource identity');
    try {
      let dimension = configuredDimension;
      if (namespace === 'oci_mysql_database') {
        // Oracle's metric docs use both resourceId and resourceID. Resolve the
        // published dimension from live metadata instead of querying the wrong
        // case and silently turning available DB CPU into missing evidence.
        const listed = await ociJson(ctx, ['monitoring', 'metric', 'list',
          '--compartment-id', f.compartment_id, '--namespace', namespace, '--name', metric, '--all']);
        const found = (listed || []).flatMap((m) => Object.entries(m.dimensions || {}))
          .find(([key, value]) => ['resourceId', 'resourceID'].includes(key) && value === id);
        if (!found) throw new Error('metric dimension unavailable');
        dimension = found[0];
      }
      const query = `${metric}[1m]{${dimension}="${id}"${namespace === 'oci_lbaas' ? ',lbComponent="loadBalancer"' : ''}}.${label === 'lbBandwidth' ? 'max' : 'mean'}()`;
      const data = await ociJson(ctx, ['monitoring', 'metric-data', 'summarize-metrics-data',
        '--compartment-id', f.compartment_id, '--namespace', namespace,
        '--query-text', query,
        '--start-time', start, '--end-time', end, '--resolution', '1m']);
      metrics[label] = { ...summarizeMetric(data, start, end), namespace, query, rawSeries: data };
      if (label === 'dbConnections') {
        const maxima = await ociJson(ctx, ['monitoring', 'metric-data', 'summarize-metrics-data',
          '--compartment-id', f.compartment_id, '--namespace', namespace,
          '--query-text', `${metric}[1m]{${dimension}="${id}"}.max()`,
          '--start-time', start, '--end-time', end, '--resolution', '1m']);
        metrics[label].max = summarizeMetric(maxima, start, end).max;
        metrics[label].rawMaximumSeries = maxima;
      }
    } catch {
      metrics[label] = { avg: null, max: null, count: 0 };
      failures.push(label);
    }
  }
  const app = [metrics.appCpu0.avg, metrics.appCpu1.avg];
  return { window: { start, end }, metrics, failures,
    appCpuPct: app.every((v) => v != null) ? (app[0] + app[1]) / 2 : null,
    dbCpuPct: metrics.dbCpu.avg,
    dbConnections: { avg: metrics.dbConnections.avg, max: metrics.dbConnections.max },
    lbBandwidth: { peakBitsPerSecond: metrics.lbBandwidth.max,
      meanBytesSentPerInterval: metrics.lbSent.avg,
      meanBytesReceivedPerInterval: metrics.lbReceived.avg,
      maxMbps: 100, source: 'OCI Monitoring; peakBandwidth bits/second, bytesSent/bytesReceived bytes per reporting interval' },
  };
}

// RFC4180 (including quoted commas/newlines and escaped quotes), no dependency.
export function csv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let n = 0; n < text.length; n++) {
    const c = text[n];
    if (c === '"') {
      if (quoted && text[n + 1] === '"') { cell += '"'; n++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  if (quoted) throw new Error('incomplete cost report');
  if (cell || row.length) rows.push([...row, cell]);
  const headers = rows.shift() || [];
  return rows.filter((r) => r.length === headers.length)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h.replace(/^\uFEFF/, ''), r[i]])));
}

export function billedCost(rows, f, start, end) {
  const lo = Date.parse(start), hi = Date.parse(end);
  const ids = f.scored_resource_ids;
  const missing = () => ({ usdPerHour: null, source: 'unmeasured', coverage: false });
  if (!ids?.length || ids.some((id) => f.generator_resource_ids?.includes(id))) return missing();
  const windows = new Map(ids.map((id) => [id, []]));
  const seen = new Set(); let cost = 0;
  for (const r of rows) {
    const id = r['product/resourceId'];
    if (!windows.has(id) || r['cost/currencyCode'] !== 'USD') continue;
    const a = Date.parse(r['lineItem/intervalUsageStart']), b = Date.parse(r['lineItem/intervalUsageEnd']);
    const raw = r['cost/myCost'], amount = raw === '' || raw == null ? NaN : Number(raw);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || !Number.isFinite(amount)) continue;
    const left = Math.max(a, lo), right = Math.min(b, hi);
    if (left >= right) continue;
    // referenceNo identifies report lines; do not silently merge conflicting
    // reports or revised duplicate lines into a fabricated billed value.
    const reference = r['lineItem/referenceNo'];
    if (!reference || seen.has(reference)) return missing();
    seen.add(reference);
    windows.get(id).push([left, right]);
    cost += amount * (right - left) / (b - a);
  }
  for (const intervals of windows.values()) {
    let covered = lo;
    for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
      if (a > covered) return missing();
      covered = Math.max(covered, b);
    }
    if (covered < hi) return missing();
  }
  return { usdPerHour: cost / ((hi - lo) / 3_600_000), source: 'OCI cost reports',
    coverage: true, window: { start, end }, scoredResources: ids.length,
    allocation: 'Billed line amounts allocated by interval overlap; generator excluded' };
}

export async function costReports(ctx, f, start, end) {
  const unavailable = { usdPerHour: null, source: 'unmeasured', coverage: false };
  // Cost-report access is optional; missing IAM/report visibility is not $0.
  if (!ctx.env.CWM_OCI_COST_REPORT_BUCKET) return unavailable;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oci-cost-'));
  try {
    const listing = await ociJson(ctx, ['os', 'object', 'list', '--namespace-name', 'bling',
      '--bucket-name', ctx.env.CWM_OCI_COST_REPORT_BUCKET, '--prefix', 'reports/cost-csv/', '--all']);
    const objects = listing?.objects || [];
    if (objects.length > 1000) return unavailable; // bound memory and API work
    const rows = [], reports = [];
    for (const [n, obj] of objects.entries()) {
      if (!obj.name.endsWith('.csv.gz') || obj.size > 100 * 1024 * 1024) continue;
      const file = path.join(dir, `${n}.gz`);
      await ociJson(ctx, ['os', 'object', 'get', '--namespace-name', 'bling',
        '--bucket-name', ctx.env.CWM_OCI_COST_REPORT_BUCKET, '--name', obj.name, '--file', file]);
      const bytes = await readFile(file);
      reports.push({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      rows.push(...csv(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')));
    }
    return { ...billedCost(rows, f, start, end), reports };
  } catch { return unavailable; }
  finally { await rm(dir, { recursive: true, force: true }); }
}
