// typical-dbsat-pscap24630-2x-v1: frozen trajectory formula and the schedule-conditioned forecast (prereg §5).
// The trajectory candidate's parameters are unchanged. All times are seconds since t = 0, the generator started_at (k6
// launch) of the FIRST rung. Workload intervals are explicit inputs: observed [start, stop) windows of earlier rungs and
// the observed start of the current rung (planned 1,200 s). Gaps, pre-load and post-stop time are excluded.
import { createHash } from 'node:crypto';

export const MODEL = Object.freeze({
  betaTime: 29.8120561524,
  betaRequests: 33.6008348159,
  betaConnections: 38.9871549291,
  initialPrepared: 928,
  initialConnections: 20,
});
export const CAP = 24630;
export const RATES = Object.freeze([300, 500, 700, 900, 1100, 1300, 1500]);
export const CONNECTIONS = Object.freeze({ 300: 130, 500: 279, 700: 491, 900: 500, 1100: 500, 1300: 500, 1500: 500 });
export const POLL_S = 15;
export const RUNG_S = 1200;
export const WARMUP_S = 300;
export const SKEW_LIMIT_S = 10; // frozen clock-skew limit between controller, generator and observer clocks
export const ANCHOR_STALE_S = 45; // descriptive anchored forecast only: an anchor poll older than this at rung start is stale
export const FORECAST_RECORD_DEADLINE_S = 2 * POLL_S; // the forecast record is written no later than workload start + 30 s

/** Scheduled offered requests after d seconds of a rung: 300 s linear ramp to rps, then rps. */
export function offered(rps, d) {
  return d <= WARMUP_S ? (rps * d * d) / (2 * WARMUP_S) : rps * (WARMUP_S / 2) + rps * (d - WARMUP_S);
}

function validateIntervals(intervals) {
  let prevStop = -Infinity;
  intervals.forEach((iv, k) => {
    if (!Number.isFinite(iv.startS) || !(iv.rps === RATES[k])) throw new Error(`interval ${k} invalid (rps or startS)`);
    if (iv.stopS != null && !(iv.stopS > iv.startS)) throw new Error(`interval ${k} stopS must exceed startS`);
    if (iv.startS < prevStop) throw new Error(`interval ${k} overlaps the previous one`);
    prevStop = iv.stopS == null ? iv.startS + RUNG_S : Math.min(iv.stopS, iv.startS + RUNG_S);
  });
}

/**
 * Modeled uncapped count at each 15 s poll inside each half-open workload interval [startS, startS+duration).
 * duration = min(stopS - startS, 1200), or 1200 if stopS is null (planned). No poll is modeled outside an interval:
 * gaps, pre-load and post-stop time are excluded from the claim (prereg §5.2). Time advances through gaps.
 * Connections are the frozen rung estimate from the interval's first poll (startup assumption, prereg §5.1).
 */
export function modeledPolls(intervals) {
  validateIntervals(intervals);
  const polls = [];
  let cumulative = 0;
  intervals.forEach((iv, k) => {
    const duration = iv.stopS == null ? RUNG_S : Math.min(iv.stopS - iv.startS, RUNG_S);
    for (let s = 0; s < duration; s += POLL_S) {
      const t = iv.startS + s;
      const count = MODEL.initialPrepared + MODEL.betaTime * (t / 600) ** 2
        + (MODEL.betaRequests * (cumulative + offered(iv.rps, s))) / 1e4
        + MODEL.betaConnections * Math.max(0, CONNECTIONS[iv.rps] - MODEL.initialConnections);
      polls.push({ k, rps: iv.rps, s, t, count });
    }
    cumulative += offered(iv.rps, duration);
  });
  return polls;
}

/** First modeled poll at or above the cap, or null when the intervals given never reach it. */
export function predictCrossing(intervals, cap = CAP) {
  const polls = modeledPolls(intervals);
  const i = polls.findIndex((p) => p.count >= cap);
  if (i < 0) return null;
  return { ...polls[i], index: i, growthPerPoll: (polls[Math.min(i + 1, polls.length - 1)].count - polls[i].count) };
}

/**
 * Descriptive anchor selection (the anchored forecast has no verdict effect). The anchor is the latest observer poll with a
 * finite Prepared_stmt_count taken at or before the rung's workload start minus the skew limit; stale if older than
 * ANCHOR_STALE_S at the rung start. polls: [{ atS, count }], seconds since t = 0.
 */
export function selectAnchor(polls, startS) {
  const usable = polls.filter((p) => Number.isFinite(p.atS) && Number.isFinite(p.count) && p.atS <= startS - SKEW_LIMIT_S);
  if (!usable.length) return { status: 'missing' };
  const poll = usable.reduce((a, b) => (b.atS > a.atS ? b : a));
  const ageS = startS - poll.atS;
  if (ageS > ANCHOR_STALE_S) return { status: 'stale', poll, ageS };
  return { status: 'ok', poll, ageS };
}

/**
 * Descriptive state-anchored forecast for ONE rung: the anchor count plus the frozen model's increments only (time-term
 * delta from absolute elapsed time, this rung's scheduled request exposure, and the connection delta of the frozen rung
 * estimate versus the prior rung's, applied at the rung's first poll). Never part of a verdict.
 */
export function anchoredForecast({ anchor, startS, rps, prevRps = null, cap = CAP }) {
  const dConn = MODEL.betaConnections * (Math.max(0, CONNECTIONS[rps] - MODEL.initialConnections)
    - (prevRps == null ? 0 : Math.max(0, CONNECTIONS[prevRps] - MODEL.initialConnections)));
  const dTime0 = MODEL.betaTime * (Math.max(0, anchor.atS) / 600) ** 2;
  for (let s = 0; s < RUNG_S; s += POLL_S) {
    const count = anchor.count + MODEL.betaTime * ((startS + s) / 600) ** 2 - dTime0
      + (MODEL.betaRequests * offered(rps, s)) / 1e4 + dConn;
    if (anchor.count >= cap || count >= cap) {
      return { crossing: { s: anchor.count >= cap ? 0 : s, t: startS + (anchor.count >= cap ? 0 : s), count }, anchorAtCap: anchor.count >= cap };
    }
  }
  return { crossing: null, anchorAtCap: false };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const isoSeconds = (iso, base) => (new Date(iso).getTime() - new Date(base).getTime()) / 1000;

/**
 * Explicit workload intervals for rungs 0..k from ISO timestamps (seconds since the first rung's startAt). Rungs before k
 * need startAt and stopAt (their observed exposure window); rung k needs only startAt and is planned (stopS null).
 * Returns null if a required timestamp is missing or inconsistent.
 */
export function intervalsFromTimes(rungs, k) {
  if (!Array.isArray(rungs) || k >= rungs.length || !rungs[0] || !rungs[0].startAt) return null;
  const base = rungs[0].startAt;
  const out = [];
  for (let i = 0; i <= k; i += 1) {
    const r = rungs[i];
    if (!r || !r.startAt || (i < k && !r.stopAt)) return null;
    const startS = isoSeconds(r.startAt, base);
    const stopS = i < k ? isoSeconds(r.stopAt, base) : null;
    if (!Number.isFinite(startS) || (stopS != null && !(stopS > startS))) return null;
    out.push({ rps: r.rps, startS, stopS });
  }
  return out;
}

/**
 * The schedule-conditioned forecast for rung k (PRIMARY predictor, prereg §5.4): the frozen formula evaluated from
 * t = 0 at the first rung's generator start, with the observed start/stop windows of rungs 0..k-1 and the observed start of
 * rung k, on the 15 s grid inside rung k's planned 1,200 s. Crossing = first grid poll with modeled count >= cap, or null.
 * It uses nothing observed after rung k's workload start.
 */
export function scheduleConditionedForecast(intervals, k, cap = CAP) {
  const polls = modeledPolls(intervals.slice(0, k + 1)).filter((p) => p.k === k);
  const hit = polls.find((p) => p.count >= cap);
  return hit ? { s: hit.s, t: hit.t, count: hit.count } : null;
}

/**
 * The record the runner writes at each rung's workload start, before that rung has any outcomes. Hashed over its inputs
 * (cap, frozen model, frozen connection estimates, explicit intervals) and its output. recordedAt is the runner clock and is
 * not hashed. rungs: [{ rps, startAt, stopAt }] (stopAt of rung k and later rungs is ignored).
 */
export function forecastRecord({ rungs, k, cap = CAP }, recordedAt) {
  const intervals = intervalsFromTimes(rungs, k);
  if (!intervals) return null;
  const input = { cap, model: MODEL, connections: CONNECTIONS, k, intervals };
  const crossing = scheduleConditionedForecast(intervals, k, cap);
  return {
    kind: 'schedule-conditioned forecast', recordedAt, k, rps: intervals[k].rps, crossing,
    inputSha256: sha256(canonicalJson(input)), outputSha256: sha256(canonicalJson(crossing)),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  // node predict.mjs record '<json {rungs:[{rps,startAt,stopAt}],k}>'
  const [mode, arg] = process.argv.slice(2);
  if (mode !== 'record') { process.stderr.write("usage: node predict.mjs record '<json {rungs,k}>'\n"); process.exit(2); }
  const out = forecastRecord(JSON.parse(arg), new Date().toISOString());
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
