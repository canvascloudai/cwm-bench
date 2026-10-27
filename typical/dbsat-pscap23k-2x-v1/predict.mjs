// typical-dbsat-pscap24k-2x-v1: frozen trajectory formula, schedule-conditioned forecast and crossing prediction.
// Prereg §5. The trajectory candidate's parameters are unchanged. All times are seconds since T0, the controller
// dispatch time (journal startedAt) of the first rung. Workload intervals are explicit inputs.
import { createHash } from 'node:crypto';

export const MODEL = Object.freeze({
  betaTime: 29.8120561524,
  betaRequests: 33.6008348159,
  betaConnections: 38.9871549291,
  initialPrepared: 928,
  initialConnections: 20,
});
export const CAP = 23552;
export const RATES = Object.freeze([300, 500, 700, 900, 1100, 1300, 1500]);
export const CONNECTIONS = Object.freeze({ 300: 130, 500: 279, 700: 491, 900: 500, 1100: 500, 1300: 500, 1500: 500 });
export const POLL_S = 15;
export const RUNG_S = 1200;
export const WARMUP_S = 300;
export const SKEW_LIMIT_S = 10; // frozen clock-skew limit between controller, generator and observer clocks
export const ANCHOR_STALE_S = 45; // frozen: an anchor poll older than this at rung start is stale (3 polls)

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
 * Anchor selection (prereg §5.5). The anchor is the latest observer poll with a finite Prepared_stmt_count taken at or
 * before the rung's workload start minus the skew limit (so it cannot contain any of the rung's own load). It is
 * stale if older than ANCHOR_STALE_S at the rung start. polls: [{ atS, count }], seconds since T0.
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
 * State-anchored, schedule-conditioned forecast for ONE rung (prereg §5.5): the anchor count plus the frozen model's
 * increments only. Increments, for the 15 s grid s = 0, 15, ... < 1200 from the rung's workload start (startS):
 *   time term: betaTime * ((startS + s)/600)^2 - betaTime * (anchor.atS/600)^2   (absolute elapsed time from T0),
 *   request term: betaRequests * offered(rps, s)/1e4                             (this rung's scheduled exposure),
 *   connection term (applied at the rung's first poll, the startup assumption):
 *     betaConnections * (max(0, N[rps]-N0) - max(0, N[prevRps]-N0)), with prevRps = null for the first rung (N = N0).
 * Observed connections are never substituted. The crossing is the first grid poll with count >= cap; a count already at
 * or above the cap at the anchor is a crossing at s = 0 (anchorAtCap).
 */
export function anchoredForecast({ anchor, startS, rps, prevRps = null, cap = CAP }) {
  const dConn = MODEL.betaConnections * (Math.max(0, CONNECTIONS[rps] - MODEL.initialConnections)
    - (prevRps == null ? 0 : Math.max(0, CONNECTIONS[prevRps] - MODEL.initialConnections)));
  const dTime0 = MODEL.betaTime * (anchor.atS / 600) ** 2;
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

/**
 * The record the runner writes at each rung's workload start, before that rung has any outcomes (prereg §5.5). It is
 * hashed over its inputs and its output; `recordedAt` is the runner clock and is not hashed.
 */
export function anchoredForecastRecord({ polls, startS, rps, prevRps = null, cap = CAP }, recordedAt) {
  const anchor = selectAnchor(polls, startS);
  if (anchor.status !== 'ok') return { kind: 'schedule-conditioned forecast', recordedAt, anchorStatus: anchor.status, anchor: null, crossing: null };
  const input = { cap, model: MODEL, connections: CONNECTIONS, rps, prevRps, startS, anchor: { atS: anchor.poll.atS, count: anchor.poll.count } };
  const f = anchoredForecast({ anchor: input.anchor, startS, rps, prevRps, cap });
  return {
    kind: 'schedule-conditioned forecast',
    recordedAt,
    anchorStatus: 'ok',
    anchor: input.anchor,
    crossing: f.crossing,
    anchorAtCap: f.anchorAtCap,
    inputSha256: sha256(canonicalJson(input)),
    outputSha256: sha256(canonicalJson(f)),
  };
}

/** Descriptive unanchored whole-ladder forecast record (secondary, never part of a verdict). */
export function unanchoredForecastRecord(intervals, recordedAt, cap = CAP) {
  const input = { cap, model: MODEL, connections: CONNECTIONS, intervals };
  const crossing = predictCrossing(intervals, cap);
  const output = crossing && { k: crossing.k, rps: crossing.rps, s: crossing.s, t: crossing.t, count: crossing.count };
  return { kind: 'unanchored ladder forecast (descriptive)', recordedAt, inputSha256: sha256(canonicalJson(input)), outputSha256: sha256(canonicalJson(output)), crossing: output };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  // node predict.mjs anchored '<json {polls,startS,rps,prevRps}>'   or   node predict.mjs unanchored '<json intervals>'
  const [mode, arg] = process.argv.slice(2);
  const now = new Date().toISOString();
  const out = mode === 'anchored' ? anchoredForecastRecord(JSON.parse(arg), now) : unanchoredForecastRecord(JSON.parse(arg || '[]'), now);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
