// typical-dbsat-pscap24k-2x-v1: frozen trajectory formula and crossing prediction (prereg §5).
// Model parameters are the trajectory candidate's, unchanged. Rung start offsets are INPUTS (seconds from the
// first rung's controller-journal startedAt), never outcomes.
export const MODEL = Object.freeze({
  betaTime: 29.8120561524,
  betaRequests: 33.6008348159,
  betaConnections: 38.9871549291,
  initialPrepared: 928,
  initialConnections: 20,
});
export const CAP = 24576;
export const RATES = Object.freeze([300, 500, 700, 900, 1100, 1300, 1500]);
export const CONNECTIONS = Object.freeze({ 300: 130, 500: 279, 700: 491, 900: 500, 1100: 500, 1300: 500, 1500: 500 });
export const POLL_S = 15;
export const RUNG_S = 1200;
export const LOCO_RMSE_MEDIAN = 1553.252;
export const TOLERANCE_POLLS = 34;

/** Uncapped modeled count at every 15 s poll of every rung that has a start offset (offsets[k] for RATES[k]). */
export function modeledPolls(offsets) {
  const polls = [];
  let cumulative = 0;
  offsets.forEach((start, k) => {
    const rps = RATES[k];
    for (let s = 0; s < RUNG_S; s += POLL_S) {
      const t = start + s;
      const req = s <= 300 ? (rps * s * s) / 600 : rps * 150 + rps * (s - 300);
      const count = MODEL.initialPrepared + MODEL.betaTime * (t / 600) ** 2
        + (MODEL.betaRequests * (cumulative + req)) / 1e4
        + MODEL.betaConnections * Math.max(0, CONNECTIONS[rps] - MODEL.initialConnections);
      polls.push({ rps, s, t, count });
    }
    cumulative += rps * 1050;
  });
  return polls;
}

/** First modeled poll at or above the cap, or null if none within the rungs given. */
export function predictCrossing(offsets, cap = CAP) {
  const polls = modeledPolls(offsets);
  const i = polls.findIndex((p) => p.count >= cap);
  return i < 0 ? null : { ...polls[i], index: i, growthPerPoll: polls[Math.min(i + 1, polls.length - 1)].count - polls[i].count };
}

// Historical rung start offsets (s from rung-1 startedAt) for the 300, 500 and 700 rungs.
export const HISTORICAL = Object.freeze({
  'conn-2x-v1.1 r1': [0, 1505.560, 3129.582],
  'conn-2x-v1.1 r2': [0, 1528.505, 3128.904],
  'pscap16k-2x-v1 r1b': [0, 1804.885, 3865.928],
  'pscap16k-2x-v1 r2': [0, 1763.857, 3846.406],
});
function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export const MEDIAN_PATTERN = Object.freeze([0, 1, 2].map((k) => Math.round(median(Object.values(HISTORICAL).map((o) => o[k])) * 1000) / 1000));
