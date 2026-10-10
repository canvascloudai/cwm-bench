#!/usr/bin/env python3
"""Deterministic candidate P95 predictor (typical-p95-v1 holdout). Reads recommended-params.json; no fitting."""
import json, math, sys
from pathlib import Path
_PARAMS = Path(__file__).resolve().parent / "recommended-params.json"
P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else _PARAMS))
def p95(servers, total, p50=0.0):
    pn = total / servers
    t = min(total, P["t_max"])
    if pn <= P["pn_max"]:
        lin = P["a"] + P["b"] * pn / 100
    else:  # linear in log-space beyond pn_max: continue slope of exp at pn_max
        lin = P["a"] + P["b"] * P["pn_max"] / 100
    core = math.exp(lin + P["c"] * t / 100)
    if pn > P["pn_max"]:
        core = core * (1 + P["b"] * (pn - P["pn_max"]) / 100)
    return max(P["floor"], p50, core)
if __name__ == "__main__":
    print("servers,total_rps,per_node_rps,model_p95_ms")
    for s in (1, 2, 3):
        for t in (300, 200, 100):
            print(f"{s},{t},{t/s:.1f},{p95(s,t):.2f}")
