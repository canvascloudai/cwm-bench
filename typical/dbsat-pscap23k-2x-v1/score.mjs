// typical-dbsat-pscap24k-2x-v1: frozen, independent scorer (prereg §6). It never runs the workload. The runner produces
// evidence; this file applies the frozen rules. Primary: did the first errno 1461 occur in the rung (half-open workload
// interval) that the state-anchored forecast recorded at that rung's start predicted, with no 1461 earlier.
import { anchoredForecast, anchoredForecastRecord, predictCrossing, POLL_S, RUNG_S, RATES, SKEW_LIMIT_S, CAP } from './predict.mjs';

export const E7_MAX_POLL_GAP_S = 30;
export const FORECAST_RECORD_DEADLINE_S = 2 * POLL_S; // recordedAt <= workload start + 30 s

const sec = (iso, t0) => (new Date(iso).getTime() - new Date(t0).getTime()) / 1000;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Score one rep. evidence = {
 *   t0, preflight:{liveParameter, inSync, harnessIntact},
 *   rungs:[{rps, startAt, stopAt, forecast}],   // startAt = generator started_at (k6 start), stopAt = actual load stop
 *   polls:[{at, threads, prepared, e1461, e1040}], faults:[{at, kind}] }
 * Result: { verdict: PASS|FAIL|NOT_ASSESSABLE|INVALID, reason, decisiveS, invalid:[...], descriptive:{...} }.
 */
export function scoreRep(ev, cap = CAP) {
  const out = { verdict: null, reason: null, decisiveS: null, invalid: [], descriptive: {} };
  const rungs = Array.isArray(ev.rungs) ? ev.rungs : [];
  const polls = (Array.isArray(ev.polls) ? ev.polls : []).filter((p) => p && p.at)
    .map((p) => ({ ...p, atS: ev.t0 ? sec(p.at, ev.t0) : NaN })).sort((a, b) => a.atS - b.atS);

  // E9 journal: every rung that started needs t0, a workload start and an actual load stop.
  if (!ev.t0 || !rungs.length) { out.invalid.push({ rule: 'E9', why: 'missing t0 or rungs' }); }
  const iv = rungs.map((r, k) => ({
    k, rps: r.rps, startS: r.startAt ? sec(r.startAt, ev.t0) : NaN, stopS: r.stopAt ? sec(r.stopAt, ev.t0) : NaN, forecast: r.forecast,
  }));
  iv.forEach((r) => {
    if (r.rps !== RATES[r.k]) out.invalid.push({ rule: 'E9', why: `rung ${r.k} rps` });
    if (!finite(r.startS) || !finite(r.stopS) || !(r.stopS > r.startS)) out.invalid.push({ rule: 'E9', why: `rung ${r.k} missing or inconsistent startAt/stopAt` });
  });
  if (polls.length < 2 || polls.some((p) => !finite(p.prepared) || !finite(p.e1461) || !finite(p.e1040))) {
    out.invalid.push({ rule: 'E9', why: 'missing poll counters' });
  }
  if (out.invalid.length) { out.verdict = 'INVALID'; out.reason = 'E9 journal/evidence fields missing'; return out; }

  // E6 / E1-E5 gate (checked by the harness evidence gate and passed in as booleans).
  const pf = ev.preflight || {};
  const preflightBad = pf.liveParameter !== cap || pf.inSync !== true || pf.harnessIntact !== true;

  // Baseline = first poll (initial error counters may be non-zero). Onset = first poll whose cumulative 1461 exceeds the
  // baseline. A decrease of a cumulative counter is a reset (a fault).
  const base = polls[0];
  let onsetIdx = -1; let resetS = null;
  for (let i = 1; i < polls.length; i += 1) {
    if ((polls[i].e1461 < polls[i - 1].e1461 || polls[i].e1040 < polls[i - 1].e1040) && resetS == null) resetS = polls[i].atS;
    if (onsetIdx < 0 && polls[i].e1461 > base.e1461 && resetS == null) onsetIdx = i;
  }
  // A reset before the onset makes the onset unattributable; a reset at/after the onset is ignored (decisive result already).

  // Membership. A poll is clearly inside rung k iff startS+skew <= at < stopS-skew; clearly outside iff clearly outside every rung
  // (at < startS-skew or at >= stopS+skew for all k). Anything else straddles a boundary.
  const place = (atS) => {
    for (const r of iv) { if (atS >= r.startS + SKEW_LIMIT_S && atS < r.stopS - SKEW_LIMIT_S) return { kind: 'in', k: r.k }; }
    const near = iv.some((r) => Math.abs(atS - r.startS) < SKEW_LIMIT_S || Math.abs(atS - r.stopS) < SKEW_LIMIT_S);
    return near ? { kind: 'boundary' } : { kind: 'gap' };
  };

  // Forecast per rung, in order (computed lazily as rungs are consulted).
  const forecasts = [];
  const forecastFor = (k) => {
    if (forecasts[k]) return forecasts[k];
    const r = iv[k];
    const apolls = polls.map((p) => ({ atS: p.atS, count: p.prepared }));
    const prevRps = k === 0 ? null : iv[k - 1].rps;
    const recomputed = anchoredForecastRecord({ polls: apolls, startS: r.startS, rps: r.rps, prevRps, cap }, null);
    let res;
    if (recomputed.anchorStatus !== 'ok') res = { k, status: recomputed.anchorStatus };
    else {
      const rec = r.forecast;
      const recordedS = rec && rec.recordedAt ? sec(rec.recordedAt, ev.t0) : NaN;
      if (!rec || rec.inputSha256 !== recomputed.inputSha256 || rec.outputSha256 !== recomputed.outputSha256) res = { k, status: 'record-bad', why: !rec ? 'no forecast record' : 'hash mismatch' };
      else if (!finite(recordedS) || recordedS > r.startS + FORECAST_RECORD_DEADLINE_S) res = { k, status: 'record-bad', why: 'recorded after the rung start window' };
      else res = { k, status: 'ok', crossing: recomputed.crossing, anchorAtCap: recomputed.anchorAtCap, record: rec };
    }
    forecasts[k] = res; return res;
  };

  // Walk the rungs in order.
  let decision = null; // {verdict, reason, decisiveS}
  const onset = onsetIdx >= 0 ? polls[onsetIdx] : null;
  const onsetPlace = onset ? place(onset.atS) : null;
  const prevPlace = onset ? place(polls[onsetIdx - 1].atS) : null;
  const onsetRung = onset && onsetPlace.kind === 'in' && prevPlace.kind === 'in' && prevPlace.k === onsetPlace.k ? onsetPlace.k : null;
  if (onset && onsetRung == null) {
    const gapOnly = onsetPlace.kind === 'gap' && prevPlace.kind === 'gap';
    decision = { verdict: 'NOT_ASSESSABLE', reason: gapOnly ? 'first 1461 in a gap or after the load stopped (outside every workload interval)' : 'first 1461 poll straddles a workload boundary or rung change', decisiveS: Infinity };
    if (gapOnly) out.descriptive.gapOnset = true;
  } else {
    for (const r of iv) {
      const f = forecastFor(r.k);
      if (f.status === 'missing' || f.status === 'stale') { decision = { verdict: 'NOT_ASSESSABLE', reason: `rung ${r.rps}: anchor poll ${f.status}`, decisiveS: r.startS }; break; }
      if (f.status === 'record-bad') { out.invalid.push({ rule: 'E8', why: `rung ${r.rps}: ${f.why}`, atS: r.startS }); decision = { verdict: 'NOT_ASSESSABLE', reason: 'forecast record not usable', decisiveS: r.startS }; break; }
      if (onsetRung === r.k) {
        // Earlier rungs were already decided above if their forecast predicted a crossing, so reaching here means none did.
        decision = f.crossing
          ? { verdict: 'PASS', reason: `first 1461 in the predicted ${r.rps} rung`, decisiveS: onset.atS }
          : { verdict: 'FAIL', reason: `first 1461 in the ${r.rps} rung, which the anchored forecast did not predict`, decisiveS: onset.atS };
        break;
      }
      // No onset in this rung (the onset, if any, is in a later rung).
      const fullyObserved = r.stopS - r.startS >= RUNG_S;
      if (f.crossing) {
        decision = fullyObserved
          ? { verdict: 'FAIL', reason: `${r.rps} rung predicted to contain the first 1461, but none occurred in it`, decisiveS: r.stopS }
          : { verdict: 'NOT_ASSESSABLE', reason: `${r.rps} rung predicted to contain the first 1461, but the rung stopped early (${Math.round(r.stopS - r.startS)} s of ${RUNG_S} s) with no 1461`, decisiveS: Infinity };
        break;
      }
      if (!fullyObserved) { decision = { verdict: 'NOT_ASSESSABLE', reason: `${r.rps} rung stopped early with no 1461 and no predicted crossing`, decisiveS: Infinity }; break; }
    }
    if (!decision) decision = { verdict: 'NOT_ASSESSABLE', reason: 'all started rungs completed with no predicted crossing and no 1461 (the prediction made no claim to test)', decisiveS: Infinity };
  }

  // E7 poll gaps, E8 runner faults, counter resets, preflight: only before the decisive result count.
  const T = decision.decisiveS;
  const lastS = polls[polls.length - 1].atS;
  const horizon = Math.min(T, lastS);
  for (let i = 1; i < polls.length && polls[i].atS <= horizon; i += 1) {
    if (polls[i].atS - polls[i - 1].atS > E7_MAX_POLL_GAP_S) { out.invalid.push({ rule: 'E7', why: 'observer poll gap', atS: polls[i].atS }); break; }
  }
  if (resetS != null && resetS <= T) out.invalid.push({ rule: 'E10', why: 'cumulative error counter reset', atS: resetS });
  for (const f of ev.faults || []) { const fs = sec(f.at, ev.t0); if (fs <= T) out.invalid.push({ rule: 'E8', why: f.kind, atS: fs }); }
  if (preflightBad) out.invalid.push({ rule: 'E6', why: 'live parameter, in-sync or harness gate not satisfied' });

  // Descriptive results (no verdict effect): rung agreement, onset timing error vs both forecasts, unanchored forecast.
  const observed = iv.map((r) => ({ rps: r.rps, startS: r.startS, stopS: r.stopS }));
  let un = null;
  try { un = predictCrossing(observed, cap); } catch { un = null; }
  const anch = forecasts.filter(Boolean).find((f) => f.crossing) || null;
  out.descriptive = {
    ...out.descriptive,
    onsetS: onset ? onset.atS : null,
    onsetRungRps: onsetRung != null ? iv[onsetRung].rps : null,
    anchoredForecastRungRps: anch ? iv[anch.k].rps : null,
    anchoredCrossingS: anch ? anch.crossing.t : null,
    onsetMinusAnchoredS: onset && anch ? onset.atS - anch.crossing.t : null,
    unanchoredCrossingS: un ? un.t : null,
    unanchoredRungRps: un ? un.rps : null,
    onsetMinusUnanchoredS: onset && un ? onset.atS - un.t : null,
    rungAgreesWithUnanchored: onsetRung != null && un ? iv[onsetRung].rps === un.rps : null,
  };
  if (out.invalid.length) { out.verdict = 'INVALID'; out.reason = out.invalid.map((x) => x.rule).join(','); return out; }
  out.verdict = decision.verdict; out.reason = decision.reason; out.decisiveS = Number.isFinite(T) ? T : null;
  return out;
}

/**
 * Campaign verdict (prereg §5.7). slots = [[attempt results of slot r1 in order], [slot r2 ...]]. A slot's counted
 * result is its first non-INVALID attempt; attempts after a non-INVALID attempt are protocol deviations and ignored.
 * At most 2 replacements in total; later attempts are ignored and flagged.
 */
export function scoreCampaign(slots) {
  const deviations = []; let replacements = 0;
  const counted = slots.map((attempts, i) => {
    let res = null;
    attempts.forEach((a, j) => {
      if (res) { deviations.push(`slot ${i + 1}: attempt ${j + 1} follows a non-invalid result and is ignored`); return; }
      if (j > 0) { replacements += 1; if (replacements > 2) { deviations.push(`slot ${i + 1}: attempt ${j + 1} exceeds the 2-replacement budget and is ignored`); return; } }
      if (a.verdict !== 'INVALID') res = a;
    });
    return res;
  });
  const v = counted.map((r) => (r ? r.verdict : 'INVALID'));
  let verdict = 'NOT DECIDED';
  if (v.includes('FAIL')) verdict = 'H0';
  else if (v.length === 2 && v.every((x) => x === 'PASS')) verdict = 'H1';
  return { verdict, slots: v, deviations };
}
