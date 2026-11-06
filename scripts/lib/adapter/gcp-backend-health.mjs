import { redact } from './redact.mjs';

export const GCP_BACKEND_HEALTH_SUSTAINED_MS = 60_000;
export const GCP_BACKEND_HEALTH_TIMEOUT_MS = 10 * 60 * 1000;
export const GCP_BACKEND_HEALTH_POLL_MS = 5_000;

export function parseInstanceRef(url) {
  const text = String(url || '');
  const match = text.match(/\/zones\/([^/]+)\/instances\/([^/?#]+)/);
  if (match) {
    return { zone: match[1], instance: match[2] };
  }
  if (text && !text.includes('/') && !/projects\//i.test(text)) {
    return { zone: null, instance: text };
  }
  return { zone: null, instance: 'unknown' };
}

export function backendsFromHealthResponse(payload) {
  const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const backends = [];
  const seen = new Set();
  for (const row of rows) {
    const statuses = (row && row.status && row.status.healthStatus)
      || (row && row.healthStatus)
      || [];
    if (!Array.isArray(statuses)) continue;
    for (const item of statuses) {
      const ref = parseInstanceRef(item && item.instance);
      const key = `${ref.zone || ''}/${ref.instance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      backends.push({
        instance: ref.instance,
        zone: ref.zone,
        healthState: item && item.healthState ? String(item.healthState) : 'UNKNOWN',
      });
    }
  }
  return backends;
}

export function summarizeBackendHealth(backends, expectedCount) {
  const expected = Number(expectedCount);
  const list = Array.isArray(backends) ? backends : [];
  const healthyCount = list.filter((item) => item.healthState === 'HEALTHY').length;
  const allListedHealthy = list.length > 0 && list.every((item) => item.healthState === 'HEALTHY');
  const allHealthy = Number.isFinite(expected) && expected > 0
    && allListedHealthy
    && healthyCount >= expected;
  return {
    backends: list,
    backendCount: list.length,
    healthyCount,
    expectedCount: Number.isFinite(expected) ? expected : null,
    allHealthy,
  };
}

export function redactBackendHealth(evidence) {
  try {
    return JSON.parse(redact(JSON.stringify(evidence)));
  } catch (err) {
    const wrapped = new Error(`backend health evidence failed redaction: ${redact(err.message)}`);
    wrapped.code = 'GCP_REDACT_FAILED';
    throw wrapped;
  }
}

function asProbeError(err) {
  return {
    code: err && err.code ? String(err.code) : 'GCP_CLI_FAILED',
    message: redact(err && err.message ? err.message : String(err)),
  };
}

export async function waitForBackendHealth(options) {
  const {
    probe,
    nowMs = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    wallMs = () => Date.now(),
    sustainedMs = GCP_BACKEND_HEALTH_SUSTAINED_MS,
    timeoutMs = GCP_BACKEND_HEALTH_TIMEOUT_MS,
    pollMs = GCP_BACKEND_HEALTH_POLL_MS,
    expectedCount,
    backendService,
  } = options;
  const startMs = nowMs();
  const wallBase = wallMs();
  const iso = () => new Date(wallBase + (nowMs() - startMs)).toISOString();
  const startedAt = iso();
  const probes = [];
  let healthySince = null;
  let firstAllHealthyAt = null;
  let lastSummary = summarizeBackendHealth([], expectedCount);

  while (nowMs() - startMs <= timeoutMs) {
    let backends = [];
    let probeError = null;
    try {
      const result = await probe();
      if (Array.isArray(result)) {
        backends = result;
      } else if (result && Array.isArray(result.backends)) {
        backends = result.backends;
        probeError = result.error || null;
      }
    } catch (err) {
      probeError = asProbeError(err);
    }
    const summary = summarizeBackendHealth(backends, expectedCount);
    lastSummary = summary;
    const at = iso();
    probes.push({
      at,
      allHealthy: summary.allHealthy,
      backendCount: summary.backendCount,
      healthyCount: summary.healthyCount,
      backends: summary.backends,
      ...(probeError ? { error: probeError } : {}),
    });
    if (summary.allHealthy) {
      if (healthySince == null) {
        healthySince = nowMs();
        firstAllHealthyAt = at;
      }
      if (nowMs() - healthySince >= sustainedMs) {
        return redactBackendHealth({
          status: 'passed',
          backendService,
          expectedCount: summary.expectedCount,
          sustainedMs,
          timeoutMs,
          pollMs,
          startedAt,
          firstAllHealthyAt,
          passedAt: at,
          timedOutAt: null,
          probeCount: probes.length,
          probes,
          lastSnapshot: summary,
        });
      }
    } else {
      healthySince = null;
    }
    if (nowMs() - startMs >= timeoutMs) break;
    await wait(pollMs);
  }

  const evidence = redactBackendHealth({
    status: 'timeout',
    backendService,
    expectedCount: lastSummary.expectedCount,
    sustainedMs,
    timeoutMs,
    pollMs,
    startedAt,
    firstAllHealthyAt,
    passedAt: null,
    timedOutAt: iso(),
    probeCount: probes.length,
    probes,
    lastSnapshot: lastSummary,
  });
  const err = new Error(
    `GCP backend health gate timed out after ${timeoutMs}ms: expected ${expectedCount} HEALTHY MIG backends for ${sustainedMs}ms; last saw ${lastSummary.healthyCount}/${lastSummary.backendCount}`,
  );
  err.code = 'GCP_BACKEND_HEALTH_TIMEOUT';
  err.replaceable = true;
  err.faultClass = 'runner';
  err.preRung = true;
  err.backendHealth = evidence;
  throw err;
}
