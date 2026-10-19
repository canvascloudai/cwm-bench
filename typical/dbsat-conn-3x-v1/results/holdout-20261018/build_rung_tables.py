#!/usr/bin/env python3
"""Per-rung tables for typical-dbsat-conn-3x-v1 (prereg §4.2, §5.3, §5.4 E2/E4 inputs).

Usage: build_rung_tables.py EVIDENCE_DIR [--out rung-tables.json]
EVIDENCE_DIR is the extracted campaign archive (typical-dbsat-conn-3x-v1-<date>/).

Sources (all inside the archive, unmodified):
  - campaign-execution.json: rung windows (start, end or breach stop), step status;
  - out/<apply>/diagnostic-time-series.json: 15 s observer polls (Prepared_stmt_count,
    Threads_connected, max_connections, max_prepared_stmt_count, global errno counters);
  - out/<apply>/breach-<key>.jsonl: breach-monitor per-minute rows (E2);
  - out/<apply>/wait-ready-show-global-variables.json (E1).
Rung window = rung start (warmup included) through rung end or breach stop.
1461/1040 deltas = global counter (events_errors_summary_global_by_error) at the last sample
inside the window minus the last sample before it.
Poll gaps: an interval of g seconds between consecutive polls counts round(g/15) - 1 missing.
"""
import argparse, json
from datetime import datetime, timedelta
from pathlib import Path

CAP = 65528
CADENCE = 15.0
SERVERS = 3


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def samples(path):
    out = []
    for x in json.loads(Path(path).read_text())["samples"]:
        st = x.get("status") or {}
        errs = {e["ERROR_NUMBER"]: int(e["SUM_ERROR_RAISED"]) for e in (x.get("errors") or [])}
        out.append({
            "at": ts(x["at"]),
            "prepared": int(st["Prepared_stmt_count"]) if st.get("Prepared_stmt_count") not in (None, "") else None,
            "threads": int(st["Threads_connected"]) if st.get("Threads_connected") not in (None, "") else None,
            "limit": int(x["max_prepared_stmt_count"]) if x.get("max_prepared_stmt_count") else None,
            "maxconn": int(x["max_connections"]) if x.get("max_connections") else None,
            "e1461": errs.get(1461, 0),
            "e1040": errs.get(1040, 0),
        })
    return sorted(out, key=lambda s: s["at"])


def missing_between(S, start, end):
    """Expected-but-absent polls in [start, end]; returns (total_missing, max_consecutive, expected)."""
    pts = [start] + [s["at"] for s in S if start <= s["at"] <= end and s["prepared"] is not None] + [end]
    tot, mx = 0, 0
    for a, b in zip(pts, pts[1:]):
        m = max(0, round((b - a).total_seconds() / CADENCE) - 1)
        tot += m
        mx = max(mx, m)
    expected = int((end - start).total_seconds() // CADENCE)
    return tot, mx, expected


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
        od = root / "out" / camp
        S = samples(od / "diagnostic-time-series.json")
        wr = json.loads((od / "wait-ready-show-global-variables.json").read_text())
        rungs, breach_decl = [], None
        for rg in apply["rungs"]:
            start, end = ts(rg["startedAt"]), ts(rg.get("endedAt") or rg["stoppedAt"])
            W = [s for s in S if start <= s["at"] <= end and s["prepared"] is not None]
            before = [s for s in S if s["at"] < start]
            b1461 = before[-1]["e1461"] if before else W[0]["e1461"]
            b1040 = before[-1]["e1040"] if before else W[0]["e1040"]
            peak = max(W, key=lambda s: s["prepared"])
            tmax = max(W, key=lambda s: s["threads"] or -1)
            ml = [s for s in W if s["threads"] is not None and s["maxconn"] and s["threads"] >= 0.98 * s["maxconn"]]
            mon = [json.loads(l) for l in (od / f"breach-typical-dbsat-{SERVERS}x-{rg['rate']}.jsonl").read_text().splitlines() if l.strip()]
            br = [m for m in mon if m.get("breach")]
            if br and breach_decl is None:
                breach_decl = ts(br[0]["evaluatedAt"])
            elig = [m for m in mon if m.get("eligible")]
            rungs.append({
                "rps": rg["rate"],
                "rps_per_server": round(rg["rate"] / SERVERS, 1),
                "window_start_utc": rg["startedAt"],
                "window_end_utc": rg.get("endedAt") or rg["stoppedAt"],
                "step_status": rg.get("stepStatus"),
                "samples": len(W),
                "mysql_1461_delta": W[-1]["e1461"] - b1461,
                "mysql_1040_delta": W[-1]["e1040"] - b1040,
                "prepared_stmt_count_peak": peak["prepared"],
                "prepared_stmt_count_peak_at_utc": peak["at"].isoformat(),
                "any_prepared_at_or_above_cap": any(s["prepared"] >= CAP for s in W),
                "threads_connected_max": tmax["threads"],
                "threads_connected_max_at_utc": tmax["at"].isoformat(),
                "max_connections_values_seen": sorted({s["maxconn"] for s in W if s["maxconn"]}),
                "first_sample_threads_ge_098_maxconn_utc": ml[0]["at"].isoformat() if ml else None,
                "samples_threads_ge_098_maxconn": len(ml),
                "stmts_per_connection_at_peak": round(peak["prepared"] / peak["threads"], 1) if peak["threads"] else None,
                "monitor_minutes": len(mon),
                "monitor_eligible_minutes": len(elig),
                "monitor_max_error_rate": max((m["errorRate"] for m in mon if m.get("errorRate") is not None), default=None),
                "monitor_max_error_rate_eligible": max((m["errorRate"] for m in elig if m.get("errorRate") is not None), default=None),
                "monitor_max_p95_ms_eligible": max((m["p95Ms"] for m in elig if m.get("p95Ms") is not None), default=None),
                "monitor_minutes_over_limit": sum(1 for m in mon if m.get("overLimit")),
                "monitor_max_consecutive": max((m.get("consecutive", 0) for m in mon), default=0),
                "monitor_data_gaps": sum(1 for m in mon if m.get("dataGap")),
                "monitor_missing_generators_max": max((m.get("missingGenerators", 0) for m in mon), default=0),
                "breach_declared_utc": br[0]["evaluatedAt"] if br else None,
                "breach_minutes": [{"minuteUtc": m["minuteUtc"], "errorRate": m["errorRate"], "p95Ms": m["p95Ms"],
                                    "overLimit": m["overLimit"]} for m in mon if m.get("overLimit")][-3:] if br else None,
                "monitor_rows": [{"minuteUtc": m["minuteUtc"], "requests": m["requests"], "failed": m["failed"],
                                  "errorRate": m["errorRate"], "p95Ms": m["p95Ms"], "eligible": m["eligible"],
                                  "overLimit": m["overLimit"], "consecutive": m["consecutive"]} for m in mon],
            })
        first_start = ts(apply["rungs"][0]["startedAt"])
        e4 = None
        if breach_decl:
            brung = [r for r in rungs if r["breach_declared_utc"]][0]
            bstart = ts(brung["window_start_utc"])
            tot_b, mx_b, exp_b = missing_between(S, bstart, breach_decl + timedelta(seconds=60))
            tot_o, mx_o, exp_o = missing_between(S, first_start, breach_decl + timedelta(seconds=60))
            e4 = {"breach_rung_to_decl_plus_60s": {"missing": tot_b, "max_consecutive_missing": mx_b, "expected": exp_b},
                  "first_rung_to_decl_plus_60s": {"missing": tot_o, "max_consecutive_missing": mx_o, "expected": exp_o,
                                                  "missing_fraction": tot_o / exp_o if exp_o else None}}
        result[rep] = {
            "campaign": camp,
            "wait_ready": wr,
            "samples_total": len(S),
            "samples_missing_status": sum(1 for s in S if s["prepared"] is None),
            "limit_values_seen": sorted({s["limit"] for s in S if s["limit"]}),
            "max_connections_values_seen": sorted({s["maxconn"] for s in S if s["maxconn"]}),
            "mysql_1461_cumulative_first_last": [S[0]["e1461"], S[-1]["e1461"]],
            "mysql_1040_cumulative_first_last": [S[0]["e1040"], S[-1]["e1040"]],
            "prepared_stmt_count_max_whole_apply": max(s["prepared"] for s in S if s["prepared"] is not None),
            "threads_connected_max_whole_apply": max(s["threads"] for s in S if s["threads"] is not None),
            "breach_declared_utc": breach_decl.isoformat() if breach_decl else None,
            "E4_polling": e4,
            "rungs": rungs,
        }
    Path(a.out).write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()
