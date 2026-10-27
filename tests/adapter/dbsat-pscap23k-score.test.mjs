// typical-dbsat-pscap23k-2x-v1: executable verdict table (prereg §5.5-§5.9, §6). The scorer is separate from the runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ANCHOR_STALE_S, CAP, CONNECTIONS, MODEL, SKEW_LIMIT_S, anchoredForecast, anchoredForecastRecord, modeledPolls,
  predictCrossing, selectAnchor, unanchoredForecastRecord,
} from '../../typical/dbsat-pscap23k-2x-v1/predict.mjs';
import { scoreCampaign, scoreRep } from '../../typical/dbsat-pscap23k-2x-v1/score.mjs';

const DIR = new URL('../../typical/dbsat-pscap23k-2x-v1/', import.meta.url);
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
  const ev = {
    t0: o.t0 === null ? undefined : iso(0),
    preflight: { liveParameter: CAP, inSync: true, harnessIntact: true, ...(o.preflight || {}) },
    polls,
    faults: o.faults || [],
    rungs: rungs.map((r, k) => {
      const apolls = polls.map((p) => ({ atS: (Date.parse(p.at) - T0) / 1000, count: p.prepared }));
      const rec = anchoredForecastRecord({ polls: apolls, startS: r.startS, rps: r.rps, prevRps: k ? rungs[k - 1].rps : null }, iso(r.startS + 1));
      const out = { rps: r.rps, startAt: r.startS == null ? undefined : iso(r.startS), stopAt: r.stopS == null ? undefined : iso(r.stopS), forecast: rec.anchorStatus === 'ok' ? rec : null };
      if (o.tamper && o.tamper === r.rps && out.forecast) out.forecast = { ...out.forecast, inputSha256: '0'.repeat(64) };
      if (o.lateRecord && o.lateRecord === r.rps && out.forecast) out.forecast = { ...out.forecast, recordedAt: iso(r.startS + 90) };
      return out;
    }),
  };
  if (o.mutate) o.mutate(ev);
  return ev;
}
const verdictOf = (o, cap) => scoreRep(makeRep(o), cap);

// ---- frozen model facts --------------------------------------------------------------------------------------------------
test('cap and model constants are the frozen ones', () => {
  assert.equal(CAP, 23552);
  assert.deepEqual({ ...MODEL }, {
    betaTime: 29.8120561524, betaRequests: 33.6008348159, betaConnections: 38.9871549291,
    initialPrepared: 928, initialConnections: 20,
  });
  for (const bad of [16382, 32764, 65528]) assert.notEqual(CAP, bad);
  assert.equal(SKEW_LIMIT_S, 10);
  assert.equal(ANCHOR_STALE_S, 45);
});

test('startup assumption: first modeled poll of rung 1 is 5,216.6 + time term, from frozen connections never observed ones', () => {
  const first = modeledPolls([{ rps: 300, startS: 0, stopS: null }])[0];
  assert.ok(Math.abs(first.count - 5216.6) < 0.1, String(first.count));
  assert.equal(CONNECTIONS[300] - MODEL.initialConnections, 110);
  assert.ok(Math.abs(MODEL.initialPrepared + MODEL.betaConnections * 110 - 5216.6) < 0.1);
});

// ---- anchor selection ------------------------------------------------------------------------------------------------------
test('anchor: latest poll at or before start minus skew; polls inside the skew band are never used', () => {
  const polls = [{ atS: 3860, count: 100 }, { atS: 3875, count: 200 }, { atS: 3890, count: 300 }, { atS: 3895, count: 999 }, { atS: 3900, count: 888 }];
  const a = selectAnchor(polls, 3900);
  assert.equal(a.status, 'ok');
  assert.equal(a.poll.count, 300);
  assert.equal(a.ageS, 10);
});
test('anchor: missing poll and stale poll are reported, not guessed', () => {
  assert.equal(selectAnchor([], 100).status, 'missing');
  assert.equal(selectAnchor([{ atS: 95, count: 5 }], 100).status, 'missing'); // inside the skew band
  assert.equal(selectAnchor([{ atS: 3900 - 45.5, count: 5 }], 3900).status, 'stale');
  assert.equal(selectAnchor([{ atS: 3900 - 45, count: 5 }], 3900).status, 'ok'); // limit is inclusive
  assert.equal(selectAnchor([{ atS: 10, count: NaN }, { atS: 20, count: undefined }], 100).status, 'missing');
  assert.equal(anchoredForecastRecord({ polls: [], startS: 100, rps: 300 }, 'x').anchorStatus, 'missing');
});
test('scorer: a missing or stale anchor makes the rep not assessable', () => {
  const noPolls = verdictOf({ onsetS: 4200, dropPolls: [3700, 3905] }); // no poll in (3700, 3905)
  assert.equal(noPolls.verdict, 'NOT_ASSESSABLE');
  assert.match(noPolls.reason, /anchor poll (stale|missing)/);
  const stale = verdictOf({ onsetS: 4200, dropPolls: [3820, 3905] }); // last poll 3815, 85 s old
  assert.equal(stale.verdict, 'NOT_ASSESSABLE');
  assert.match(stale.reason, /stale/);
});

// ---- anchored forecast arithmetic ----------------------------------------------------------------------------------------------
test('anchored forecast uses only the model increments from the anchor count', () => {
  const anchor = { atS: 3885, count: 14000 };
  const f = anchoredForecast({ anchor, startS: 3900, rps: 700, prevRps: 500 });
  // by hand at s = 300: time + request + connection deltas
  const dT = MODEL.betaTime * (((3900 + 300) / 600) ** 2 - (3885 / 600) ** 2);
  const dR = (MODEL.betaRequests * (700 * 150)) / 1e4;
  const dC = MODEL.betaConnections * (491 - 279);
  const c300 = 14000 + dT + dR + dC;
  assert.ok(c300 < CAP + 400);
  const g = anchoredForecast({ anchor: { atS: 3885, count: 23552 }, startS: 3900, rps: 700, prevRps: 500 });
  assert.deepEqual(g.crossing && g.crossing.s, 0);
  assert.equal(g.anchorAtCap, true);
  assert.ok(f.crossing === null || f.crossing.s >= 0);
});

// ---- verdict table: primary criterion --------------------------------------------------------------------------------------------
test('PASS: first 1461 in the predicted 700 rung, far from the predicted instant (no timing hurdle)', () => {
  const r = verdictOf({ onsetS: 3900 + 100 });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.descriptive.onsetRungRps, 700);
  assert.equal(r.descriptive.anchoredForecastRungRps, 700);
  assert.ok(Math.abs(r.descriptive.onsetMinusAnchoredS) > 100, 'timing error is reported only');
  assert.ok(Number.isFinite(r.descriptive.onsetMinusUnanchoredS));
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
  assert.match(earlier.reason, /500 rung, which the anchored forecast did not predict/);
});
test('FAIL: first 1461 in a rung whose anchored forecast has no crossing (low anchor)', () => {
  const r = verdictOf({ onsetS: 4400, prepared: (s) => (s >= 3900 ? 5000 + (s - 3900) : preparedAt(s, DEFAULT_RUNGS) / 2) });
  assert.equal(r.descriptive.anchoredForecastRungRps, null);
  assert.equal(r.verdict, 'FAIL');
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
    (ev) => { delete ev.t0; },
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

test('historical patterns: unanchored forecast and anchored forecasts at the chosen cap (descriptive table, prereg §5.6)', () => {
  const expected = { // anchored 700-rung crossing offset s*, unanchored 700-rung crossing offset
    'pscap16k-2x-v1 r1b': [0, 165], 'pscap16k-2x-v1 r2': [225, 165], 'conn-2x-v1.1 r1': [0, 345], 'conn-2x-v1.1 r2': [1095, 345],
  };
  for (const [name, p] of Object.entries(patterns)) {
    const t0 = Date.parse(p.t0);
    const polls = csv(name).map((r) => ({ atS: (Date.parse(r[1]) - t0) / 1000, count: Number(r[4]) }));
    const recs = p.intervals.slice(0, 3).map((iv, k) => anchoredForecastRecord({ polls, startS: iv.startS, rps: iv.rps, prevRps: k ? p.intervals[k - 1].rps : null }, null));
    assert.ok(recs.every((r) => r.anchorStatus === 'ok'), name);
    assert.equal(recs[0].crossing, null, name);
    assert.equal(recs[1].crossing, null, name);
    assert.equal(recs[2].crossing.s, expected[name][0], name);
    const un = predictCrossing(p.intervals.slice(0, 3).map((iv, i) => ({ rps: iv.rps, startS: iv.startS, stopS: i < 2 ? iv.stopS : null })));
    assert.equal(un.rps, 700, name);
    assert.equal(un.s, expected[name][1], name);
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
  // Origin: the fit's t = 0 (first tagged poll) is within 3 s of the controller dispatch (journal startedAt) of rung 1, so the
  // prospective T0 (rung-1 dispatch) is the same origin. The k6 start is 18-47 s later and starts the request exposure.
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
  for (const needle of ['29.8120561524', '33.6008348159', '38.9871549291', '23552', '23,552', 'ba432f902ba8c35de670448f4e43fdfce204c2ff',
    '8747a554126ee34b57898be44a74e579913f570b', '300: 130; 500: 279; 700: 491; 900: 500']) {
    assert.ok(doc.includes(needle), `prereg is missing ${needle}`);
  }
  assert.ok(!doc.includes('N = 34') && !/within\s+±510/.test(doc), 'the 510 s tolerance was dropped from the verdict');
});
test('unanchored record is descriptive and hashed', () => {
  const rec = unanchoredForecastRecord([{ rps: 300, startS: 30, stopS: 1250 }, { rps: 500, startS: 1800, stopS: 3020 }, { rps: 700, startS: 3900, stopS: null }], 'x');
  assert.match(rec.kind, /descriptive/);
  assert.match(rec.inputSha256, /^[0-9a-f]{64}$/);
});
