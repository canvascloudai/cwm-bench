#!/usr/bin/env python3
"""Per-rung §4.1 records for typical-dbsat-pscap-v1 with the unchanged dbsat-v1 scorer.

Usage: build_records.py EVIDENCE_DIR [--out records.json]
EVIDENCE_DIR is the extracted campaign archive (typical-dbsat-pscap-v1-20261017/); the
raw k6 gzips are needed. Records come from score_dbsat_v1.record_from_collect with the raw
k6 samples, request_outcomes_from_k6 and steady_span_from_k6 (no change to the scorer).
Rep 1 at 900 has no live collect (post-breach harness failure), so its record is built
from the raw k6 file only and every collect-derived field is null.
`phase_steady_p95_ms` (nearest rank over all phase=steady points) is reported alongside.
"""
import argparse, glob, gzip, json, math, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TYPICAL = HERE.parents[2]
sys.path.insert(0, str(TYPICAL / "dbsat-v1"))
sys.path.insert(0, str(TYPICAL / "p95-v1"))
import score_dbsat_v1 as s  # noqa: E402
import score_p95_v1 as p95  # noqa: E402

LADDER = (300, 500, 700, 900)


def phase_p95(path, phase="steady"):
    vals = []
    with gzip.open(path, "rt", errors="replace") as h:
        for line in h:
            if '"http_req_duration"' not in line or f'"phase":"{phase}"' not in line:
                continue
            o = json.loads(line)
            if o.get("type") != "Point" or o.get("metric") != "http_req_duration":
                continue
            d = o["data"]
            if (d.get("tags") or {}).get("phase") == phase:
                vals.append(float(d["value"]))
    vals.sort()
    return (vals[max(1, math.ceil(0.95 * len(vals))) - 1] if vals else None), len(vals)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evidence")
    ap.add_argument("--out", default="records.json")
    a = ap.parse_args()
    out = Path(a.evidence) / "out"
    recs = []
    for rep in (1, 2):
        camp = f"typical-dbsat-pscap-4x-r{rep}-20261017"
        for rps in LADDER:
            k6 = glob.glob(str(out / camp / f"rungs/typical-dbsat-4x-{rps}-*/k6.json.gz"))[0]
            cpath = out / camp / f"11-typical-dbsat-4x-{rps}.collect.json"
            ro = s.request_outcomes_from_k6(k6)
            span = s.steady_span_from_k6(k6)
            pp95, pn = phase_p95(k6)
            r = {"servers": 4, "rps": rps, "rep": rep}
            if cpath.exists():
                c = json.loads(cpath.read_text())
                rec = s.record_from_collect(c, p95.read_request_samples(k6), servers=4, rps=rps, rep=rep,
                                            steady_span=span, request_outcomes=ro)
                rec["db_pressure"] = s.db_pressure(rec)
                r.update(rec)
                r["record_source"] = "record_from_collect (unchanged scorer)"
            else:
                fails = sum(ro["classes"].values())
                secs = (span[1] - span[0]).total_seconds() if span[0] else None
                r.update({
                    "status": "overload (breach stop; no live collect)",
                    "steady_p95_ms": None,
                    "achieved_rps": ro["total"] / secs if secs else None,
                    "achieved_rps_elapsed_s": secs,
                    "achieved_rps_elapsed_source": "k6 steady-phase span (includes drain after the stop)",
                    "error_rate": fails / ro["total"] if ro["total"] else None,
                    "error_rates_by_class": {k: v / ro["total"] for k, v in ro["classes"].items()},
                    "error_classes_source": "k6 request_outcomes (steady)",
                    "error_counts_by_status_class": ro["by_status_class"],
                    "app_cpu_by_node": None, "db_cpu_mean": None, "connections_max": None,
                    "pi_aas_mean": None, "wait_shares": None, "pool_wait_p95_ms": None,
                    "generator": None, "alb_elb_5xx_ratio": None, "target_connection_errors": None,
                    "record_source": "raw k6 only (collect unavailable)",
                })
            r["phase_steady_p95_ms"] = pp95
            r["phase_steady_points"] = pn
            r["steady_request_outcomes_total"] = ro["total"]
            r["steady_span_utc"] = [span[0].isoformat() if span[0] else None, span[1].isoformat() if span[1] else None]
            recs.append(r)
    Path(a.out).write_text(json.dumps(s._jsonable({"records": recs}), indent=1) + "\n")


if __name__ == "__main__":
    main()
