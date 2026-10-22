#!/usr/bin/env python3
"""typical-dbsat-conn-2x-v1.1: per-rep H1/H0/mixed and campaign verdict.
Strict lookup on PREREGISTRATION.md §5.4 (primary matrix only; no sensitivity case) using
rung-tables.json and records.json. Validity (§5.5) inputs: E1/E4 from rung-tables, E2 monitor
rows, E3/E5 from the runner's generator-validity and download-verification records (see RESULTS.md).
Usage: evaluate_conn2x_v11.py [--tables rung-tables.json] [--records records.json] [--out verdict.json]"""
import argparse, json
from pathlib import Path
CAP, MAXCONN, B_STAR = 65528, 500, 900
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--tables", default="rung-tables.json")
    ap.add_argument("--records", default="records.json"); ap.add_argument("--out", default="verdict.json")
    a = ap.parse_args()
    T = json.loads(Path(a.tables).read_text()); R = json.loads(Path(a.records).read_text())["records"]
    out = {"reps": {}}
    for k, t in sorted(T.items()):
        rep = int(k); rungs = t["rungs"]
        B = next((r["rps"] for r in rungs if r.get("breach_declared_utc")), None)
        br = next(r for r in rungs if r["rps"] == B) if B else None
        rec = next(r for r in R if r["rep"] == rep and r["rps"] == B) if B else None
        mins = []
        if br:
            mins = [m for m in (br.get("breach_minutes") or [])]
        thr_ok = any((r["threads_connected_max"] or 0) >= 0.98 * MAXCONN for r in rungs if B is None or r["rps"] <= B)
        tot1461 = sum(r["mysql_1461_delta"] for r in rungs)
        prep_ok = t["prepared_stmt_count_max_whole_apply"] < CAP
        tmc = rec["tmc_share_of_failures"] if rec else None
        c = {"B": B, "server_limit_reached": thr_ok, "mysql_1461_total": tot1461,
             "prepared_max": t["prepared_stmt_count_max_whole_apply"], "tmc_share_of_failures_at_B": tmc}
        if B is not None and B <= 700: v = "H0(a)"
        elif B != B_STAR: v = "H0(b)"
        elif tot1461 > 0: v = "H0(d)"
        elif not prep_ok: v = "H0(e)"
        elif tmc is None or tmc <= 0.50 or not thr_ok: v = "H0(c)"
        else: v = "H1 (check error criterion in each breach minute)"
        c["verdict"] = v; out["reps"][rep] = c
    vs = [c["verdict"] for c in out["reps"].values()]
    out["campaign"] = "H0" if all(v.startswith("H0") for v in vs) else ("H1" if all(v.startswith("H1") for v in vs) else "not decided")
    Path(a.out).write_text(json.dumps(out, indent=1) + "\n"); print(json.dumps(out, indent=1))
if __name__ == "__main__": main()
