#!/usr/bin/env python3
"""typical-dbsat-cpu-2x-r5xl-v1: per-rep H1/H0 and campaign verdict (PREREGISTRATION.md §5.4/§5.5).

Strict lookup against the frozen nominal §5.2 prediction (no breach 300..1500). Sensitivity variants are
never consulted. Inputs: rung-tables.json (runner breach monitor, E1 wait-ready), breach-minutes.json
(independent raw-k6 recomputation of §3.1), records.json (unchanged scorer + steady failure classes),
gate.json (runner E1..E5 evidence gate, copied per rep). Validity uses the gate plus the checks below.
Usage: evaluate_cpu_r5xl_v1.py [--out verdict.json]"""
import argparse, json
from pathlib import Path
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default="verdict.json"); a = ap.parse_args()
    T = json.loads(Path("rung-tables.json").read_text()); M = json.loads(Path("breach-minutes.json").read_text())
    R = json.loads(Path("records.json").read_text())["records"]; G = json.loads(Path("gate.json").read_text())
    out = {"prediction_scored": "nominal §5.2: no qualifying breach 300..1500", "reps": {}}
    for k in sorted(T):
        t, m, g = T[k], M[k], G[k]
        B_mon = next((r["rps"] for r in t["rungs"] if r["breach_declared_utc"]), None)
        B_raw = m["first_breach_rps"]
        wr = t["wait_ready"]
        e1 = wr["max_prepared_stmt_count"] == 65528 and wr["max_connections"] == 500 and \
             g["hardware"]["DBInstanceClass"] == "db.r5.xlarge" and g["hardware"]["vcpus"] == 4
        valid = e1 and all(g["E"].values()) and g["intact"] and not g["reasons"] and g["failure"] is None \
            and len(t["rungs"]) == (7 if B_mon is None else [300, 500, 700, 900, 1100, 1300, 1500].index(B_mon) + 1)
        rec = next((r for r in R if str(r["rep"]) == k and r["rps"] == B_raw), None)
        fc = rec["steady_failure_classes"] if rec else {}
        nf = sum(fc.values()); dom = max(fc, key=fc.get) if fc else None
        if not valid: v = "invalid (not scored)"
        elif B_mon != B_raw: v = "not decided (monitor/raw disagreement)"
        elif B_raw is None: v = "H1"
        else: v = "H0"
        out["reps"][k] = {"campaign": t["campaign"], "valid": valid, "E1_detail": e1, "gate_E": g["E"],
                          "B_monitor": B_mon, "B_raw_recomputed": B_raw, "verdict": v,
                          "dominant_class_at_B": dom, "dominant_share_of_failures": fc[dom] / nf if dom else None,
                          "mechanism": (f"{dom} dominant (>50% of failures)" if dom and fc[dom] / nf > 0.5 else "no class > 50%") if B_raw else None}
    vs = [r["verdict"] for r in out["reps"].values()]
    out["campaign"] = "H1" if vs and all(v == "H1" for v in vs) else ("H0" if vs and all(v == "H0" for v in vs) else "not decided")
    Path(a.out).write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
if __name__ == "__main__": main()
