#!/usr/bin/env python3
"""Per-rung §4.2 tables for typical-dbsat-pscap-v1 from the 15 s observer polls.

Usage: build_rung_tables.py EVIDENCE_DIR [--out rung-tables.json]
EVIDENCE_DIR is the extracted campaign archive (typical-dbsat-pscap-v1-20261017/).
Rung window = rung start (warmup included) through rung end or breach stop, from
campaign-execution.json. 1461/1040 deltas are differences of the global MySQL
counters (performance_schema events_errors_summary_global_by_error) between the
last sample before the rung and the last sample inside it.
"""
import argparse, json
from datetime import datetime
from pathlib import Path

CAP = 65528


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def samples(path):
    out = []
    for x in json.loads(Path(path).read_text())["samples"]:
        st = x.get("status") or {}
        errs = {e["ERROR_NUMBER"]: int(e["SUM_ERROR_RAISED"]) for e in (x.get("errors") or [])}
        out.append({
            "at": ts(x["at"]),
            "prepared": int(st["Prepared_stmt_count"]) if st.get("Prepared_stmt_count") else None,
            "threads": int(st["Threads_connected"]) if st.get("Threads_connected") else None,
            "limit": int(x["max_prepared_stmt_count"]) if x.get("max_prepared_stmt_count") else None,
            "e1461": errs.get(1461, 0),
            "e1040": errs.get(1040, 0),
        })
    return sorted(out, key=lambda s: s["at"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evidence")
    ap.add_argument("--out", default="rung-tables.json")
    a = ap.parse_args()
    root = Path(a.evidence)
    ce = json.loads((root / "campaign-execution.json").read_text())
    result = {}
    for apply in ce["applies"]:
        camp = apply["campaign"]
        rep = camp.split("-r")[1][0]
        S = samples(root / "out" / camp / "diagnostic-time-series.json")
        gaps = [(b["at"] - a_["at"]).total_seconds() for a_, b in zip(S, S[1:])]
        rungs = []
        for rg in apply["rungs"]:
            start, end = ts(rg["startedAt"]), ts(rg.get("endedAt") or rg["stoppedAt"])
            W = [s for s in S if start <= s["at"] <= end and s["prepared"] is not None]
            before = [s for s in S if s["at"] < start]
            b1461 = before[-1]["e1461"] if before else W[0]["e1461"]
            b1040 = before[-1]["e1040"] if before else W[0]["e1040"]
            peak = max(W, key=lambda s: s["prepared"])
            at_cap = [s for s in W if s["prepared"] >= CAP]
            spc = [s["prepared"] / s["threads"] for s in W if s["threads"]]
            rungs.append({
                "rps": rg["rate"],
                "window_start_utc": rg["startedAt"],
                "window_end_utc": rg.get("endedAt") or rg["stoppedAt"],
                "step_status": rg.get("stepStatus", "breach stop (no live collect)" if rg.get("abortedRawPreserved") else None),
                "samples": len(W),
                "mysql_1461_delta": W[-1]["e1461"] - b1461,
                "mysql_1040_delta": W[-1]["e1040"] - b1040,
                "prepared_stmt_count_peak": peak["prepared"],
                "prepared_stmt_count_peak_at_utc": peak["at"].isoformat(),
                "prepared_stmt_count_last5": [s["prepared"] for s in W[-5:]],
                "first_sample_at_cap_utc": at_cap[0]["at"].isoformat() if at_cap else None,
                "threads_connected_max": max(s["threads"] for s in W if s["threads"] is not None),
                "stmts_per_connection_at_peak": round(peak["prepared"] / peak["threads"], 1) if peak["threads"] else None,
                "stmts_per_connection_range": [round(min(spc), 1), round(max(spc), 1)] if spc else None,
            })
        result[rep] = {
            "campaign": camp,
            "samples_total": len(S),
            "samples_missing_prepared": sum(1 for s in S if s["prepared"] is None),
            "max_gap_s": max(gaps) if gaps else None,
            "limit_values_seen": sorted({s["limit"] for s in S}),
            "mysql_1461_cumulative_first_last": [S[0]["e1461"], S[-1]["e1461"]],
            "prepared_stmt_count_max_whole_apply": max(s["prepared"] for s in S if s["prepared"] is not None),
            "rungs": rungs,
        }
    Path(a.out).write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()
