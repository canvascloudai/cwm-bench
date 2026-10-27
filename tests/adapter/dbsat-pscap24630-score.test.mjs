// typical-dbsat-pscap24630-2x-v1: executable verdict table (prereg §5.4-§5.11, §6). The scorer is separate from the runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ANCHOR_STALE_S, CAP, CONNECTIONS, FORECAST_RECORD_DEADLINE_S, MODEL, SKEW_LIMIT_S, anchoredForecast, forecastRecord, intervalsFromTimes,
  modeledPolls, offered, predictCrossing, scheduleConditionedForecast, selectAnchor,
} from '../../typical/dbsat-pscap24630-2x-v1/predict.mjs';
import { scoreCampaign, scoreRep } from '../../typical/dbsat-pscap24630-2x-v1/score.mjs';

const DIR = new URL('../../typical/dbsat-pscap24630-2x-v1/', import.meta.url);
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (s) => new Date(T0 + s * 1000).toISOString();

// ---- synthetic rep builder -------------------------------------------------------------------------------------------
const DEFAULT_RUNGS = [
  { rps: 300, startS: 30, stopS: 1250 },
  { rps: 500, startS: 1800, stopS: 3020 },
  { rps: 700, startS: 3900, stopS: 5120 },
];
function preparedAt(s, rungs) {
  const r700 = rungs.find((r) => r.rps === 700);
  if (r700 && s >= r700.startS) return Math.round(14000 + (s - r700.startS) * 12);
  const r500 = rungs.find((r) => r.rps === 500);
  if (r500 && s >= r500.startS) return 14000;
  const r300 = rungs.find((r) => r.rps === 300);
  if (r300 && s >= r300.startS) return 6000;
  return 900;
}
function makeRep(o = {}) {
  const rungs = o.rungs || DEFAULT_RUNGS;
  const endS = o.endS ?? (rungs.at(-1).stopS + 120);
  const base1461 = o.base1461 ?? 0;
  const base1040 = o.base1040 ?? 0;
  const polls = [];
  for (let s = 5; s <= endS; s += 15) {
    if (o.dropPolls && s > o.dropPolls[0] && s < o.dropPolls[1]) continue;
    const onset = o.onsetS != null && s >= o.onsetS;
    const reset = o.resetS != null && s >= o.resetS;
    polls.push({
      at: iso(s), threads: 100, prepared: o.prepared ? o.prepared(s) : preparedAt(s, rungs),
      e1461: reset ? 0 : base1461 + (onset ? 5 : 0), e1040: base1040,
    });
  }
  for (const extra of o.extraPolls || []) polls.push(extra);
  polls.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const evRungs = rungs.map((r) => ({ rps: r.rps, startAt: r.startS == null ? undefined : iso(r.startS), stopAt: r.stopS == null ? undefined : iso(r.stopS) }));
  const ev = {
    preflight: { liveParameter: CAP, inSync: true, harnessIntact: true, ...(o.preflight || {}) },
    polls,
    faults: o.faults || [],
    rungs: evRungs.map((r, k) => {
      const rec = forecastRecord({ rungs: evRungs, k }, iso(rungs[k].startS + 1));
      const out = { ...r, forecast: rec };
      if (o.tamper && o.tamper === r.rps && out.forecast) out.forecast = { ...out.forecast, inputSha256: '0'.repeat(64) };
      if (o.lateRecord && o.lateRecord === r.rps && out.forecast) out.forecast = { ...out.forecast, recordedAt: iso(rungs[k].startS + 90) };
      return out;
    }),
  };
  if (o.mutate) o.mutate(ev);
  return ev;
}
const verdictOf = (o, cap) => scoreRep(makeRep(o), cap);

// ---- frozen model facts --------------------------------------------------------------------------------------------------
test('cap and model constants are the frozen ones', () => {
  assert.equal(CAP, 24630);
  assert.deepEqual({ ...MODEL }, {
    betaTime: 29.8120561524, betaRequests: 33.6008348159, betaConnections: 38.9871549291,
    initialPrepared: 928, initialConnections: 20,
  });
  for (const bad of [16382, 32764, 65528]) assert.notEqual(CAP, bad); // never a value in the fit data or the superseded scenario
  assert.equal(SKEW_LIMIT_S, 10);
  assert.equal(ANCHOR_STALE_S, 45); // descriptive anchored forecast only
  assert.equal(FORECAST_RECORD_DEADLINE_S, 30);
});

test('startup assumption: first modeled poll of rung 1 is 5,216.6 + time term, from frozen connections never observed ones', () => {
  const first = modeledPolls([{ rps: 300, startS: 0, stopS: null }])[0];
  assert.ok(Math.abs(first.count - 5216.6) < 0.1, String(first.count));
  assert.equal(CONNECTIONS[300] - MODEL.initialConnections, 110);
  assert.ok(Math.abs(MODEL.initialPrepared + MODEL.betaConnections * 110 - 5216.6) < 0.1);
});

// ---- the primary predictor: schedule-conditioned forecast ---------------------------------------------------------------------
const RUNGS3 = [
  { rps: 300, startAt: iso(30), stopAt: iso(1250) },
  { rps: 500, startAt: iso(1800), stopAt: iso(3020) },
  { rps: 700, startAt: iso(3900) },
];
test('intervals: t = 0 is the first rung generator start; earlier rungs use observed windows, the current one is planned', () => {
  const iv = intervalsFromTimes(RUNGS3, 2);
  assert.deepEqual(iv, [{ rps: 300, startS: 0, stopS: 1220 }, { rps: 500, startS: 1770, stopS: 2990 }, { rps: 700, startS: 3870, stopS: null }]);
  assert.equal(intervalsFromTimes(RUNGS3, 0)[0].stopS, null);
  assert.equal(intervalsFromTimes([{ rps: 300, startAt: iso(30) }, { rps: 500, startAt: iso(1800) }], 1), null, 'an earlier rung without stopAt');
  assert.equal(intervalsFromTimes([{ rps: 300 }], 0), null);
});
test('forecast arithmetic: frozen formula, observed exposure windows, gaps excluded, frozen connection estimates', () => {
  const iv = intervalsFromTimes(RUNGS3, 2);
  const f = scheduleConditionedForecast(iv, 2);
  assert.ok(f && f.s >= 0 && f.s < 1200);
  // by hand at the crossing poll: time from the first rung start, cumulative scheduled requests over the observed windows
  const cum = offered(300, 1200) + offered(500, 1200); // min(stop - start, 1200) of the earlier rungs
  const by = 928 + MODEL.betaTime * (((3870 + f.s) / 600) ** 2) + (MODEL.betaRequests * (cum + offered(700, f.s))) / 1e4 + MODEL.betaConnections * (491 - 20);
  assert.ok(Math.abs(by - f.count) < 1e-6, `${by} vs ${f.count}`);
  assert.ok(f.count >= CAP);
  const polls = modeledPolls(iv).filter((p) => p.k === 2);
  assert.ok(polls.find((p) => p.s === f.s - 15 && p.count < CAP), 'the poll before the crossing is below the cap');
  assert.equal(scheduleConditionedForecast(intervalsFromTimes(RUNGS3, 0), 0), null, 'the 300 rung never reaches the cap');
  assert.equal(scheduleConditionedForecast(intervalsFromTimes(RUNGS3, 1), 1), null, 'nor the 500 rung');
});
test('forecast is schedule-conditioned: a later observed start or a shorter earlier window moves it; nothing after rung start does', () => {
  const base = scheduleConditionedForecast(intervalsFromTimes(RUNGS3, 2), 2);
  const later = scheduleConditionedForecast(intervalsFromTimes([RUNGS3[0], RUNGS3[1], { rps: 700, startAt: iso(3900 + 600) }], 2), 2);
  assert.ok(later.t > base.t - 1 && later.s < base.s, 'a later start adds elapsed time, so the crossing comes earlier in the rung');
  const shorter = scheduleConditionedForecast(intervalsFromTimes([RUNGS3[0], { ...RUNGS3[1], stopAt: iso(1800 + 600) }, RUNGS3[2]], 2), 2);
  assert.ok(shorter.s > base.s, 'less observed exposure delays the crossing');
  const a = forecastRecord({ rungs: RUNGS3, k: 2 }, 'x');
  const b = forecastRecord({ rungs: [...RUNGS3.slice(0, 2), { ...RUNGS3[2], stopAt: iso(5120) }, { rps: 900, startAt: iso(6000) }], k: 2 }, 'y');
  assert.equal(a.inputSha256, b.inputSha256, 'later rungs and this rung stop time are not inputs');
  assert.equal(a.outputSha256, b.outputSha256);
  const c = forecastRecord({ rungs: RUNGS3.map((r, i) => (i === 0 ? { ...r, stopAt: iso(1251) } : r)), k: 2 }, 'x');
  assert.notEqual(a.inputSha256, c.inputSha256, 'observed earlier windows are hashed inputs');
});
test('forecast record: kind, rung, crossing and hashes', () => {
  const rec = forecastRecord({ rungs: RUNGS3, k: 2 }, 'now');
  assert.equal(rec.kind, 'schedule-conditioned forecast');
  assert.equal(rec.rps, 700);
  assert.ok(rec.crossing && rec.crossing.s >= 0);
  assert.match(rec.inputSha256, /^[0-9a-f]{64}$/);
  assert.equal(forecastRecord({ rungs: [{ rps: 300 }], k: 0 }, 'now'), null);
});

// ---- descriptive state-anchored forecast (no verdict effect) ---------------------------------------------------------------------
test('descriptive anchor selection: latest poll at or before start minus skew; missing and stale are reported, not guessed', () => {
  const polls = [{ atS: 3860, count: 100 }, { atS: 3875, count: 200 }, { atS: 3890, count: 300 }, { atS: 3895, count: 999 }, { atS: 3900, count: 888 }];
  const a = selectAnchor(polls, 3900);
  assert.equal(a.status, 'ok');
  assert.equal(a.poll.count, 300);
  assert.equal(a.ageS, 10);
  assert.equal(selectAnchor([], 100).status, 'missing');
  assert.equal(selectAnchor([{ atS: 95, count: 5 }], 100).status, 'missing');
  assert.equal(selectAnchor([{ atS: 3900 - 45.5, count: 5 }], 3900).status, 'stale');
  assert.equal(selectAnchor([{ atS: 3900 - 45, count: 5 }], 3900).status, 'ok');
  assert.equal(selectAnchor([{ atS: 10, count: NaN }, { atS: 20, count: undefined }], 100).status, 'missing');
});
test('a missing anchor does not change the verdict (the anchored forecast is descriptive only)', () => {
  const ref = verdictOf({ onsetS: 4200 });
  const noFirstAnchor = verdictOf({ onsetS: 4200, mutate: (ev) => { ev.polls = ev.polls.filter((p) => Date.parse(p.at) - T0 > 25000); } });
  assert.equal(ref.verdict, 'PASS');
  assert.equal(noFirstAnchor.verdict, 'PASS'); // no poll at or before the first rung start - 10 s: anchor missing for rung 1 only
  assert.equal(ref.descriptive.anchoredForecastRungRps, 700);
  assert.equal(noFirstAnchor.descriptive.anchoredForecastRungRps, 700);
  // a stale anchor needs a poll gap above 45 s, which is itself an E7 fault before the decisive result
  const stale = verdictOf({ onsetS: 4200, dropPolls: [3820, 3905] });
  assert.equal(stale.verdict, 'INVALID');
  assert.ok(stale.invalid.every((x) => x.rule === 'E7'));
});
test('descriptive anchored forecast arithmetic uses only the model increments from the anchor count', () => {
  const anchor = { atS: 3885, count: 14000 };
  const f = anchoredForecast({ anchor, startS: 3900, rps: 700, prevRps: 500 });
  assert.ok(f.crossing === null || f.crossing.s >= 0);
  const g = anchoredForecast({ anchor: { atS: 3885, count: CAP }, startS: 3900, rps: 700, prevRps: 500 });
  assert.equal(g.crossing.s, 0);
  assert.equal(g.anchorAtCap, true);
});

// ---- verdict table: primary criterion --------------------------------------------------------------------------------------------
test('PASS: first 1461 in the predicted 700 rung, far from the predicted instant (no timing hurdle)', () => {
  const r = verdictOf({ onsetS: 3900 + 100 });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.descriptive.onsetRungRps, 700);
  assert.equal(r.descriptive.forecastRungRps, 700);
  assert.ok(Math.abs(r.descriptive.onsetMinusForecastS) > 100, 'timing error is reported only, with no hurdle');
  assert.ok(Number.isFinite(r.descriptive.onsetMinusAnchoredS));
});
test('FAIL: first 1461 in an adjacent rung, even when close in time to the predicted instant', () => {
  const next = verdictOf({ // 900 rung started and the onset is in it; the 700 rung ran fully with no 1461
    rungs: [...DEFAULT_RUNGS, { rps: 900, startS: 6000, stopS: 7000 }], onsetS: 6100,
    prepared: (s) => preparedAt(s, DEFAULT_RUNGS),
  });
  assert.equal(next.verdict, 'FAIL');
  assert.match(next.reason, /700 rung predicted to contain the first 1461, but none occurred in it/);
  const earlier = verdictOf({ onsetS: 2500 }); // 500 rung, forecast has no crossing there
  assert.equal(earlier.verdict, 'FAIL');
  assert.match(earlier.reason, /500 rung, which the schedule-conditioned forecast did not predict/);
});
test('FAIL: first 1461 in the 300 rung, whose forecast has no crossing', () => {
  const r = verdictOf({ onsetS: 600 });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.descriptive.forecastRungRps, 700);
});
test('gap onset: a 1461 first seen outside every workload interval is not assessable', () => {
  const r = verdictOf({ onsetS: 3300 }); // between the 500 stop (3020) and the 700 start (3900)
  assert.equal(r.verdict, 'NOT_ASSESSABLE');
  assert.match(r.reason, /gap or after the load stopped/);
  assert.equal(r.descriptive.gapOnset, true);
  const post = verdictOf({ onsetS: 5300, endS: 5400 }); // after the 700 load stopped
  assert.equal(post.verdict, 'NOT_ASSESSABLE');
});
test('boundary-straddling polls: onset poll within the skew band, or a previous poll across the boundary, is not assessable', () => {
  const inBand = verdictOf({ onsetS: 3905, extraPolls: [] }); // poll at 3905 = start + 5
  assert.equal(inBand.verdict, 'NOT_ASSESSABLE');
  assert.match(inBand.reason, /straddles/);
  const acrossStart = verdictOf({ onsetS: 3920 }); // previous poll 3905 lies in the band
  assert.equal(acrossStart.verdict, 'NOT_ASSESSABLE');
  const clearIn = verdictOf({ onsetS: 3935 }); // previous poll 3920 is clearly inside
  assert.equal(clearIn.verdict, 'PASS');
  const acrossStop = verdictOf({ onsetS: 5120 - 5 }); // poll at 5115 is within the band before the stop
  assert.equal(acrossStop.verdict, 'NOT_ASSESSABLE');
});
test('valid early stop before the predicted rung ends with no 1461 is NOT ASSESSABLE (never replaced)', () => {
  const early = verdictOf({ rungs: [DEFAULT_RUNGS[0], DEFAULT_RUNGS[1], { rps: 700, startS: 3900, stopS: 3900 + 541 }] });
  assert.equal(early.verdict, 'NOT_ASSESSABLE');
  assert.match(early.reason, /stopped early/);
  const camp = scoreCampaign([[early], [verdictOf({ onsetS: 4000 })]]);
  assert.equal(camp.verdict, 'NOT DECIDED');
  const withReplacement = scoreCampaign([[early, verdictOf({ onsetS: 4000 })], [verdictOf({ onsetS: 4000 })]]);
  assert.equal(withReplacement.verdict, 'NOT DECIDED');
  assert.match(withReplacement.deviations.join(' '), /follows a non-invalid result/);
});
test('early stop after the first 1461 is still decided by the onset', () => {
  const r = verdictOf({ rungs: [DEFAULT_RUNGS[0], DEFAULT_RUNGS[1], { rps: 700, startS: 3900, stopS: 3900 + 541 }], onsetS: 4100 });
  assert.equal(r.verdict, 'PASS');
});
test('absent crossing: no predicted crossing and no 1461 gives no test; no 1461 in a fully observed predicted rung is FAIL', () => {
  const none = verdictOf({ rungs: [DEFAULT_RUNGS[0], DEFAULT_RUNGS[1]] });
  assert.equal(none.verdict, 'NOT_ASSESSABLE');
  assert.match(none.reason, /no predicted crossing and no 1461/);
  const fullNoOnset = verdictOf({});
  assert.equal(fullNoOnset.verdict, 'FAIL');
  assert.match(fullNoOnset.reason, /none occurred in it/);
});
test('missing journal fields make the rep invalid (E9)', () => {
  for (const mutate of [
    (ev) => { delete ev.rungs[2].startAt; },
    (ev) => { delete ev.rungs[1].stopAt; },
    (ev) => { delete ev.rungs[0].startAt; },
    (ev) => { ev.rungs[2].stopAt = ev.rungs[2].startAt; },
    (ev) => { ev.polls[3].e1461 = undefined; },
  ]) {
    const r = verdictOf({ onsetS: 4100, mutate });
    assert.equal(r.verdict, 'INVALID');
    assert.ok(r.invalid.some((x) => x.rule === 'E9'));
  }
});
test('nonzero initial error counters: the onset is an increase over the first poll', () => {
  const pass = verdictOf({ onsetS: 4100, base1461: 7, base1040: 3 });
  assert.equal(pass.verdict, 'PASS');
  const quiet = verdictOf({ base1461: 7, base1040: 3 }); // constant non-zero counters are not an onset
  assert.equal(quiet.descriptive.onsetS, null);
  assert.equal(quiet.verdict, 'FAIL'); // fully observed predicted rung without a 1461
});
test('counter resets: a reset before the decisive result is invalid; one after it is ignored', () => {
  const before = verdictOf({ onsetS: 4100, resetS: 3500, base1461: 3 });
  assert.equal(before.verdict, 'INVALID');
  assert.ok(before.invalid.some((x) => x.rule === 'E10'));
  const after = verdictOf({ onsetS: 4100, mutate: (ev) => { for (const p of ev.polls) if (Date.parse(p.at) - T0 >= 4400000) p.e1461 = 0; } });
  assert.equal(after.verdict, 'PASS');
});
test('faults after a decisive result do not matter; faults before it make the rep invalid (E7, E8 precede post-breach rules)', () => {
  const late = verdictOf({ onsetS: 4100, faults: [{ at: iso(4500), kind: 'runner crash' }], dropPolls: [4300, 4500] });
  assert.equal(late.verdict, 'PASS');
  const early = verdictOf({ onsetS: 4100, faults: [{ at: iso(2000), kind: 'runner CPU throttling' }] });
  assert.equal(early.verdict, 'INVALID');
  assert.ok(early.invalid.some((x) => x.rule === 'E8'));
  const gap = verdictOf({ onsetS: 4100, dropPolls: [2000, 2100] });
  assert.equal(gap.verdict, 'INVALID');
  assert.ok(gap.invalid.some((x) => x.rule === 'E7'));
  const pre = verdictOf({ onsetS: 4100, preflight: { liveParameter: 16382 } });
  assert.equal(pre.verdict, 'INVALID');
});
test('forecast record integrity: a missing, altered or late record is a runner fault (E8)', () => {
  assert.equal(verdictOf({ onsetS: 4100, tamper: 700 }).verdict, 'INVALID');
  assert.equal(verdictOf({ onsetS: 4100, lateRecord: 700 }).verdict, 'INVALID');
  const missing = verdictOf({ onsetS: 4100, mutate: (ev) => { ev.rungs[1].forecast = null; } });
  assert.equal(missing.verdict, 'INVALID');
});
test('campaign verdicts and replacements', () => {
  const P = verdictOf({ onsetS: 4100 });
  const F = verdictOf({ onsetS: 2500 });
  const NA = verdictOf({ onsetS: 3300 });
  const INV = verdictOf({ onsetS: 4100, faults: [{ at: iso(2000), kind: 'x' }] });
  assert.equal(scoreCampaign([[P], [P]]).verdict, 'H1');
  assert.equal(scoreCampaign([[P], [F]]).verdict, 'H0');
  assert.equal(scoreCampaign([[P], [NA]]).verdict, 'NOT DECIDED');
  assert.equal(scoreCampaign([[INV, P], [P]]).verdict, 'H1'); // an invalid rep may be replaced
  assert.equal(scoreCampaign([[INV, INV, INV], [INV, INV]]).verdict, 'NOT DECIDED');
  assert.match(scoreCampaign([[INV, INV, INV], [INV, INV]]).deviations.join(' '), /2-replacement budget/);
});

// ---- descriptive unanchored forecast and the historical fixtures -----------------------------------------------------
const patterns = JSON.parse(readFileSync(new URL('fixtures/historical-patterns.json', DIR), 'utf8'));
const FILES = {
  'pscap16k-2x-v1 r1b': 'pscap16k-poll-series-r1b-rungs.csv', 'pscap16k-2x-v1 r2': 'pscap16k-poll-series-r2-rungs.csv',
  'conn-2x-v1.1 r1': 'conn-2x-v1.1-poll-series-rep1.csv', 'conn-2x-v1.1 r2': 'conn-2x-v1.1-poll-series-rep2.csv',
};
const csv = (name) => readFileSync(new URL(`fixtures/${FILES[name]}`, DIR), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));

// Historical gap patterns, rebased so t = 0 is each rep's first-rung generator start (k6 start). Earlier rungs use their observed
// [start, stop) windows; the 700 rung is planned.
const rebased = (p) => { const o = p.intervals[0].startS; return p.intervals.slice(0, 3).map((iv, i) => ({ rps: iv.rps, startS: iv.startS - o, stopS: i < 2 ? iv.stopS - o : null })); };
function margins(cap) {
  const per = {};
  for (const [name, p] of Object.entries(patterns)) {
    const all = modeledPolls(rebased(p));
    const r = all.filter((q) => q.k === 2);
    const prevMax = Math.max(...all.filter((q) => q.k < 2).map((q) => q.count));
    const i = r.findIndex((q) => q.count >= cap);
    if (prevMax >= cap || i < 0) return null; // the 700 rung must be the predicted rung
    per[name] = { s: r[i].s, time: Math.min(r[i].s, 1200 - r[i].s), startGap: cap - r[0].count, endGap: r.at(-1).count - cap };
    per[name].stmts = Math.min(per[name].startGap, per[name].endGap);
  }
  const v = Object.values(per);
  return { per, time: Math.min(...v.map((x) => x.time)), stmts: Math.min(...v.map((x) => x.stmts)) };
}

test('historical patterns: the schedule-conditioned forecast puts the first 1461 mid-700 under all four gap patterns (prereg §5.8)', () => {
  const expectedS = { 'pscap16k-2x-v1 r1b': 555, 'pscap16k-2x-v1 r2': 555, 'conn-2x-v1.1 r1': 705, 'conn-2x-v1.1 r2': 705 };
  const m = margins(CAP);
  assert.ok(m, 'every pattern predicts the 700 rung');
  for (const name of Object.keys(patterns)) assert.equal(m.per[name].s, expectedS[name], name);
  assert.ok(m.time >= 495, `min time margin ${m.time}`);
  assert.ok(m.stmts >= 1287, `min statement margin ${m.stmts}`);
  for (const [name, p] of Object.entries(patterns)) {
    const iv = rebased(p);
    const f0 = scheduleConditionedForecast(iv, 0);
    const f1 = scheduleConditionedForecast(iv, 1);
    assert.equal(f0, null, name);
    assert.equal(f1, null, name);
    assert.equal(scheduleConditionedForecast(iv, 2).s, expectedS[name], name);
  }
});

test('cap choice rule: maximize the minimum margin in time and in statements over the four gap patterns, excluding fit-data caps', () => {
  const EXCLUDED = new Set([16382, 32764, 65528]);
  const rows = [];
  for (let c = 20000; c <= 30000; c += 1) { if (EXCLUDED.has(c)) continue; const m = margins(c); if (m) rows.push({ c, time: m.time, stmts: m.stmts }); }
  const tMax = Math.max(...rows.map((r) => r.time));
  const aMax = Math.max(...rows.map((r) => r.stmts));
  assert.equal(tMax, 525);
  assert.ok(Math.abs(aMax - 1369.9) < 0.1, String(aMax));
  const best = rows.reduce((a, r) => (Math.min(r.time / tMax, r.stmts / aMax) > Math.min(a.time / tMax, a.stmts / aMax) ? r : a));
  assert.equal(best.c, CAP);
  assert.equal(best.time, 495);
  assert.ok(Math.abs(best.stmts - 1287.8) < 0.1, String(best.stmts));
  // the individual optima bracket the choice: time margin peaks at 24,536-24,541, statement margin at 24,712-24,714
  assert.deepEqual(rows.filter((r) => r.time === tMax).map((r) => r.c).filter((c) => c === 24536 || c === 24541).length, 2);
  assert.ok(rows.some((r) => r.c === 24713 && Math.abs(r.stmts - aMax) < 1.5));
});

test('descriptive anchored forecast at the chosen cap (no verdict effect): anchors and crossings under the four patterns', () => {
  const expected = { // [anchor count at the 700 start, anchored crossing offset in the 700 rung or null]
    'pscap16k-2x-v1 r1b': [16382, 0], 'pscap16k-2x-v1 r2': [14955, 585], 'conn-2x-v1.1 r1': [16412, 0], 'conn-2x-v1.1 r2': [12396, null],
  };
  for (const [name, p] of Object.entries(patterns)) {
    const o = p.intervals[0].startS;
    const t0 = Date.parse(p.t0);
    const polls = csv(name).map((r) => ({ atS: (Date.parse(r[1]) - t0) / 1000 - o, count: Number(r[4]) }));
    const iv = p.intervals[2];
    const a = selectAnchor(polls, iv.startS - o);
    assert.equal(a.status, 'ok', name);
    assert.equal(a.poll.count, expected[name][0], name);
    const f = anchoredForecast({ anchor: a.poll, startS: iv.startS - o, rps: 700, prevRps: 500 });
    assert.equal(f.crossing ? f.crossing.s : null, expected[name][1], name);
  }
});

test('time-origin shift: the prospective t = 0 (first rung generator start) is 18-47 s after the fit origin; the effect is under 45 statements', () => {
  for (const [name, p] of Object.entries(patterns)) {
    const iv = rebased(p);
    const shift = p.intervals[0].startS; // seconds the fit's elapsed time is ahead
    const fit = modeledPolls(iv.map((r) => ({ ...r, startS: r.startS + shift, stopS: r.stopS == null ? null : r.stopS + shift })));
    const pro = modeledPolls(iv);
    const maxDiff = Math.max(...fit.map((q, i) => q.count - pro[i].count));
    assert.ok(maxDiff > 0 && maxDiff < 45, `${name} ${maxDiff}`);
  }
});

test('fit-pipeline fixture: origin, baseline and exposure windows of the fit map onto the prospective calculation', () => {
  // The fit pipeline: elapsed time from the first tagged poll; P0 and N0 from that poll; exposure from each rung's
  // first tagged poll; observed Threads_connected as N. The prospective calculation differs only where documented.
  const resid = (name, cap) => {
    const rows = csv(name).filter((r) => r[8] !== '');
    const t = rows.map((r) => Date.parse(r[1]) / 1000);
    const P0 = Number(rows[0][4]);
    const N0 = Number(rows[0][3]);
    const rungs = [];
    rows.forEach((r, i) => { const k = Number(r[8]); if (!rungs.length || rungs.at(-1).k !== k) rungs.push({ k, first: t[i], last: t[i] }); rungs.at(-1).last = t[i]; });
    const res = [];
    rows.forEach((r, i) => {
      let cum = 0;
      for (const rr of rungs) {
        if (rr.k === Number(r[8])) { const s = t[i] - rr.first; cum += s <= 300 ? (rr.k * s * s) / 600 : rr.k * 150 + rr.k * (s - 300); break; }
        cum += rr.k * (150 + (rr.last - rr.first + 15 - 300));
      }
      const pred = Math.min(cap, P0 + MODEL.betaTime * (((t[i] - t[0]) / 60) / 10) ** 2 + (MODEL.betaRequests * cum) / 1e4 + MODEL.betaConnections * Math.max(0, Number(r[3]) - N0));
      if (Number(r[4]) >= cap) return;
      res.push(pred - Number(r[4]));
    });
    return { rmse: Math.sqrt(res.reduce((a, x) => a + x * x, 0) / res.length), n: res.length, P0, N0, t0: rows[0][1] };
  };
  const a = resid('pscap16k-2x-v1 r1b', 16382);
  const b = resid('pscap16k-2x-v1 r2', 16382);
  assert.ok(Math.abs(a.rmse - 1443.25) < 0.1, String(a.rmse)); // published full-fit RMSE 1,443.3
  assert.ok(Math.abs(b.rmse - 686.4) < 0.1, String(b.rmse)); // published full-fit RMSE 686.4
  // Baselines: P0 = 928 and N0 = 20 are the rounded medians of the first poll of the four runs.
  const firsts = Object.keys(FILES).map((n) => resid(n, 1e9));
  const median = (x) => { const s = [...x].sort((p, q) => p - q); return (s[1] + s[2]) / 2; };
  assert.equal(median(firsts.map((f) => f.P0)), MODEL.initialPrepared);
  assert.equal(median(firsts.map((f) => f.N0)), MODEL.initialConnections);
  // Origin: the fit's t = 0 (first tagged poll) is within 3 s of the controller dispatch (journal startedAt) of rung 1. The
  // prospective t = 0 is the first rung's generator start (k6), 18-47 s later; the effect on the model is bounded below.
  for (const [name, p] of Object.entries(patterns)) {
    const first = Date.parse(csv(name).find((r) => r[8] !== '')[1]);
    const lag = (first - Date.parse(p.t0)) / 1000;
    assert.ok(lag >= 0 && lag <= 3, `${name} first tagged poll ${lag}s after dispatch`);
    const startLag = p.intervals[0].startS - p.intervals[0].dispatchS;
    assert.ok(startLag >= 18 && startLag <= 47, `${name} k6 start lag ${startLag}`);
    // the prospective rung offsets are k6-start based; the fit used first-tagged-poll based rung starts (dispatch)
    p.intervals.forEach((iv) => assert.ok(iv.startS - iv.dispatchS >= 10 && iv.startS - iv.dispatchS <= 47, name));
  }
});

test('the 32,764 / 1,100 prediction is archived as superseded and absent from the live scenario', () => {
  const doc = readFileSync(new URL('PREREGISTRATION.md', DIR), 'utf8');
  assert.match(doc, /superseded/i);
  assert.ok(existsFile('superseded/pscap32k-prediction.md'));
});
function existsFile(rel) { try { readFileSync(new URL(rel, DIR)); return true; } catch { return false; } }

test('frozen files are pinned by hash in the prereg', () => {
  const doc = readFileSync(new URL('PREREGISTRATION.md', DIR), 'utf8');
  for (const f of ['predict.mjs', 'score.mjs']) {
    const h = createHash('sha256').update(readFileSync(new URL(f, DIR))).digest('hex');
    assert.ok(doc.includes(h), `${f} sha256 ${h} is not pinned in the prereg`);
  }
  for (const needle of ['29.8120561524', '33.6008348159', '38.9871549291', '24630', '24,630', 'ba432f902ba8c35de670448f4e43fdfce204c2ff',
    '8747a554126ee34b57898be44a74e579913f570b', '300: 130; 500: 279; 700: 491; 900: 500']) {
    assert.ok(doc.includes(needle), `prereg is missing ${needle}`);
  }
  assert.ok(!doc.includes('N = 34') && !/within\s+±510/.test(doc), 'the 510 s tolerance was dropped from the verdict');
});
