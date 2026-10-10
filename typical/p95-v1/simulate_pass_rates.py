#!/usr/bin/env python3
"""Monte Carlo pass rates for typical-p95-v1 (draft). Simulation under ASSUMED noise and independence; not a known probability."""
import math, random, statistics as st, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "predictions"))
from predict_p95 import p95
random.seed(20261010)
N = 200_000
SIG_S, SIG_R = 0.095, {300: 0.25, 200: 0.25, 100: 0.093}
LO, HI = 0.666, 1.432
TOL = {300: 1.6, 200: 1.6, 100: 1.3}
ENG = {(1,300):18.1,(1,200):14.6,(1,100):11.0,(2,300):12.78,(2,200):11.01,(2,100):9.23,(3,300):11.01,(3,200):9.83,(3,100):8.64}
cells = [(s, t) for s in (1, 2, 3) for t in (300, 200, 100)]
pred = {c: p95(*c) for c in cells}
score = lambda m, p: 100 - 100 * abs(m - p) / m
cnt = dict(a=0, b=0, c=0, abs=0, sc300=0, scother=0, sc=0, both=0, cell300=0)
for _ in range(N):
    med = {}
    for c in cells:
        mu = math.log(pred[c]) + random.gauss(0, SIG_S)
        med[c] = math.exp(st.median([mu + random.gauss(0, SIG_R[c[1]]) for _ in range(3)]))
    inb = {c: LO * pred[c] <= med[c] <= HI * pred[c] for c in cells}
    a = sum(inb.values()) >= 8 and all(inb[(s, 300)] for s in (1, 2, 3))
    b = st.median(score(med[c], pred[c]) for c in cells) >= 80
    cc = all(score(med[(s, 300)], pred[(s, 300)]) > score(med[(s, 300)], ENG[(s, 300)]) for s in (1, 2, 3))
    def tr(lo_s, t):  # ratio P95(fewer servers)/P95(more servers)
        pr = pred[(lo_s, t)] / pred[(lo_s + 1, t)]; mr = med[(lo_s, t)] / med[(lo_s + 1, t)]
        ok = abs(math.log(mr / pr)) <= math.log(TOL[t])
        if pr >= 1.25: ok = ok and mr > 1
        return ok
    s300 = tr(1, 300) and tr(2, 300)
    sother = sum(tr(1, t) + tr(2, t) for t in (200, 100)) >= 3
    A = a and b and cc; S = s300 and sother
    for k, v in dict(a=a, b=b, c=cc, abs=A, sc300=s300, scother=sother, sc=S, both=A and S, cell300=inb[(1,300)]).items():
        cnt[k] += v
for k, v in cnt.items(): print(f"{k},{100*v/N:.1f}")
