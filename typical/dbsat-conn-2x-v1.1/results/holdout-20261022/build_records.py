#!/usr/bin/env python3
"""Per-rung records for typical-dbsat-conn-2x-v1.1 (adapted from conn-3x, SERVERS=2) with the unchanged dbsat-v1 scorer.

Usage: build_records.py EVIDENCE_DIR [--repo REPO_ROOT] [--out records.json]
EVIDENCE_DIR is the extracted campaign archive (typical-dbsat-conn-2x-v1.1 (adapted from conn-3x, SERVERS=2)-<date>/); the raw
k6 gzips are needed. Records come from score_dbsat_v1.record_from_collect with the raw k6
samples, request_outcomes_from_k6 and steady_span_from_k6 (no change to the scorer).
Also emitted per rung (prereg §5.3 inputs):
  - steady request_outcomes counts by (status, errorClass), recounted from raw k6,
  - TMC share = too_many_connections (503) / all failure points (status >= 400 or 0),
  - phase_steady_p95_ms (nearest rank over all phase=steady points),
  - iterations and dropped_iterations from raw k6 (E5 on the breach rung).
"""
import argparse, collections, glob, gzip, json, math, sys
from pathlib import Path

LADDER = (300, 500, 700, 900, 1100, 1300, 1500)
SERVERS = 2


def k6_scan(path):
    """One pass over raw k6: steady durations, steady request_outcomes, dropped iterations."""
    durs, outcomes, dropped, iters = [], collections.Counter(), 0.0, 0.0
    with gzip.open(path, "rt", errors="replace") as h:
        for line in h:
            if '"Point"' not in line:
                continue
            if '"http_req_duration"' in line and '"phase":"steady"' in line:
                o = json.loads(line)
                if o.get("metric") == "http_req_duration" and (o["data"].get("tags") or {}).get("phase") == "steady":
                    durs.append(float(o["data"]["value"]))
            elif '"request_outcomes"' in line and '"phase":"steady"' in line:
                o = json.loads(line)
                t = o["data"].get("tags") or {}
                if o.get("metric") == "request_outcomes" and t.get("phase") == "steady":
                    outcomes[(str(t.get("http_status")), t.get("error_class"))] += float(o["data"]["value"])
            elif '"metric":"iterations"' in line:
                o = json.loads(line)
                if o.get("metric") == "iterations":
                    iters += float(o["data"]["value"])
            elif '"dropped_iterations"' in line:
                o = json.loads(line)
                if o.get("metric") == "dropped_iterations":
                    dropped += float(o["data"]["value"])
    durs.sort()
    p95 = durs[max(1, math.ceil(0.95 * len(durs))) - 1] if durs else None
    return p95, len(durs), outcomes, dropped, iters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evidence")
    ap.add_argument("--repo", default=None, help="cwm-bench checkout (for typical/dbsat-v1 scorer)")
    ap.add_argument("--out", default="records.json")
    a = ap.parse_args()
    repo = Path(a.repo) if a.repo else Path(__file__).resolve().parents[4]
    sys.path.insert(0, str(repo / "typical" / "dbsat-v1"))
    sys.path.insert(0, str(repo / "typical" / "p95-v1"))
    import score_dbsat_v1 as s  # noqa: E402
    import score_p95_v1 as p95  # noqa: E402

    root = Path(a.evidence)
    ce = json.loads((root / "campaign-execution.json").read_text())
    recs = []
    for apply in ce["applies"]:
        camp = apply["campaign"]
        rep = int(camp.split("-r")[1][0])
        for rg in apply["rungs"]:
            rps = rg["rate"]
            k6 = glob.glob(str(root / "out" / camp / f"rungs/typical-dbsat-{SERVERS}x-{rps}-*/k6.json.gz"))[0]
            cpath = root / "out" / camp / f"11-typical-dbsat-{SERVERS}x-{rps}.collect.json"
            ro = s.request_outcomes_from_k6(k6)
            span = s.steady_span_from_k6(k6)
            pp95, pn, oc, dropped, iters = k6_scan(k6)
            r = {"servers": SERVERS, "rps": rps, "rep": rep, "step_status": rg.get("stepStatus")}
            if cpath.exists():
                c = json.loads(cpath.read_text())
                rec = s.record_from_collect(c, p95.read_request_samples(k6), servers=SERVERS, rps=rps, rep=rep,
                                            steady_span=span, request_outcomes=ro)
                rec["db_pressure"] = s.db_pressure(rec)
                r.update(rec)
                r["record_source"] = "record_from_collect (unchanged scorer)"
            else:
                r["record_source"] = "raw k6 only (collect unavailable)"
            # TMC share per prereg §5.3, classed exactly as request_outcomes_from_k6.
            fail_pts = sum(ro["classes"].values())
            tmc = ro["classes"].get("too_many_connections", 0)
            r["steady_outcome_counts"] = [{"status": st, "errorClass": ec, "count": int(v)}
                                          for (st, ec), v in sorted(oc.items(), key=lambda kv: -kv[1])]
            r["steady_outcomes_total"] = int(ro["total"])
            r["steady_failure_points"] = int(fail_pts)
            r["steady_failure_classes"] = {k: int(v) for k, v in ro["classes"].items()}
            r["steady_failure_rate_k6"] = fail_pts / ro["total"] if ro["total"] else None
            r["tmc_503"] = int(tmc)
            r["tmc_share_of_failures"] = tmc / fail_pts if fail_pts else None
            r["phase_steady_p95_ms"] = pp95
            r["phase_steady_points"] = pn
            r["k6_dropped_iterations"] = dropped
            r["k6_iterations"] = iters
            r["steady_span_utc"] = [span[0].isoformat() if span[0] else None, span[1].isoformat() if span[1] else None]
            recs.append(r)
    Path(a.out).write_text(json.dumps(s._jsonable({"records": recs}), indent=1) + "\n")


if __name__ == "__main__":
    main()
