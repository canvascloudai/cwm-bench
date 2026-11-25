#!/usr/bin/env python3
"""oci-holdout-v1 scorer. Recomputes every scored measurement from the
redacted campaign archive and scores it against the frozen predictions.

  python3 recompute.py raw   <attempt dir> <rps>              # one rung -> JSON
  python3 recompute.py score <archive root> <predictions.json> <out dir>

Measurement (PREREGISTRATION.md "Measurement"):
- Latency: nearest-rank ceil(p*N)-1 over raw k6 http_req_duration points that
  carry phase=steady and fall in [start+300 s, start+1200 s) of the rung's
  completion marker (generator-recorded UTC). Ramp samples are excluded.
- Throughput: steady completed requests / 900 s.
- Total loss % (the scored error %): steady requests that did not complete with
  a 2xx, plus dropped iterations, over (requests + dropped iterations).
  Hard errors %: steady http_req_failed rate.
- App CPU % (mean of the two app nodes), DB CPU %, DB connections avg/max from
  the OCI Monitoring 1-minute series saved in collect-<rps>.json, steady window,
  keeping a point when t >= start and t + 60 s <= end (the pinned
  oci-evidence.mjs rule).
- Cost: null for every rung (no OCI cost report covered the run windows).

Composite (PREREGISTRATION.md "Composite", typical/score.py rel/errs):
  rel(sim, ref) = max(0, 100 - |sim - ref| / |ref| * 100); 100 when ref == 0
  error: 100 if |sim - ref| <= 0.01 pp, else max(100*0.01/|sim - ref|, rel),
         with rel taken as 0 when ref == 0
  weights P50 .20, P95 .25, CPU .20, throughput .15, error .10, cost .10.
  Cost null -> composite without cost, the five weights renormalized by 1/0.9.
A rung passes at composite >= 95. A set is verified only if every rung of both
reps passes. Sets A and B are scored separately and never combined.
"""
import csv
import gzip
import json
import math
import os
import sys
from datetime import datetime, timezone

REPS = {1: "oci-holdout-v1-r1-ad1-20261123", 2: "oci-holdout-v1-r2-ad1-20261124"}
RUNGS = (10, 100, 500, 1000)
W = dict(p50=0.20, p95=0.25, cpu=0.20, thr=0.15, err=0.10, cost=0.10)


def parse_ts(text):
    # k6 writes RFC 3339 with up to 9 fractional digits; keep integer ns.
    text = text.replace("Z", "+00:00")
    main, _, zone = text.partition("+") if "+" in text[19:] else (text, "", "")
    if "." in main:
        base, frac = main.split(".")
    else:
        base, frac = main, ""
    dt = datetime.fromisoformat(base + "+" + (zone or "00:00"))
    return int(dt.timestamp()) * 10**9 + int(frac.ljust(9, "0")[:9])


def nr(sorted_vals, p):
    return sorted_vals[math.ceil(p * len(sorted_vals)) - 1]


def raw(attempt_dir, rps):
    run = os.path.join(attempt_dir, "raw", f"rung-{rps}")
    marker = json.load(open(os.path.join(run, "complete.json")))
    assert marker["exitCode"] == 0
    start = parse_ts(marker["startedAt"])
    lo, hi = start + 300 * 10**9, start + 1200 * 10**9
    dur, statuses, failed, nfailed, drops, reqs = [], {}, 0, 0, 0, 0
    with gzip.open(os.path.join(run, "k6.json.gz"), "rt") as fh:
        for line in fh:
            if '"Point"' not in line:
                continue
            row = json.loads(line)
            m = row.get("metric")
            if m not in ("http_req_duration", "http_req_failed", "http_reqs", "dropped_iterations"):
                continue
            d = row["data"]
            tags = d.get("tags", {})
            assert tags.get("campaign_id") == marker["campaignId"] and tags.get("run_id") == marker["runId"]
            t = parse_ts(d["time"])
            if not (lo <= t < hi):
                continue
            if m == "dropped_iterations":
                drops += d["value"]
                continue
            if tags.get("phase") != "steady":
                continue
            if m == "http_req_duration":
                dur.append(d["value"])
                s = str(tags.get("status", "0"))
                statuses[s] = statuses.get(s, 0) + 1
            elif m == "http_req_failed":
                nfailed += 1
                failed += d["value"]
            else:
                reqs += d["value"]
    dur.sort()
    n = len(dur)
    assert n == reqs == nfailed, (n, reqs, nfailed)
    ok = sum(v for k, v in statuses.items() if k.isdigit() and 200 <= int(k) <= 299)
    denom = n + drops
    collect = json.load(open(os.path.join(attempt_dir, f"collect-{rps}.json")))
    mon = monitoring(collect["monitoring"])
    return dict(
        rps=rps, campaignId=marker["campaignId"], measurementSha=marker["measurementSha"],
        steadyStartUtc=datetime.fromtimestamp(lo / 1e9, timezone.utc).isoformat(),
        steadyEndUtc=datetime.fromtimestamp(hi / 1e9, timezone.utc).isoformat(),
        n=n, droppedIterations=drops, httpStatuses=statuses,
        p50Ms=nr(dur, .50), p95Ms=nr(dur, .95), p99Ms=nr(dur, .99),
        throughputRps=n / 900.0,
        totalLossPct=100.0 * (denom - ok) / denom, hardErrorPct=100.0 * failed / n,
        **mon,
    )


def monitoring(mon):
    lo = datetime.fromisoformat(mon["window"]["start"].replace("Z", "+00:00")).timestamp()
    hi = datetime.fromisoformat(mon["window"]["end"].replace("Z", "+00:00")).timestamp()

    def avg(series, fn=lambda v: sum(v) / len(v)):
        pts = [p for s in series for p in s["aggregated-datapoints"]]
        vals = [p["value"] for p in pts
                if lo <= datetime.fromisoformat(p["timestamp"]).timestamp() and
                datetime.fromisoformat(p["timestamp"]).timestamp() + 60 <= hi]
        return fn(vals), len(vals)

    m = mon["metrics"]
    a0, n0 = avg(m["appCpu0"]["rawSeries"])
    a1, n1 = avg(m["appCpu1"]["rawSeries"])
    db, _ = avg(m["dbCpu"]["rawSeries"])
    ca, _ = avg(m["dbConnections"]["rawSeries"])
    cm, _ = avg(m["dbConnections"]["rawMaximumSeries"], max)
    return dict(appCpuNode0Pct=a0, appCpuNode1Pct=a1, appCpuPct=(a0 + a1) / 2,
                monitoringPoints=min(n0, n1), dbCpuPct=db, dbConnectionsAvg=ca,
                dbConnectionsMax=cm, costPerHour=None)


def rel(sim, ref):
    if ref == 0:
        return 100.0
    return max(0.0, 100 - abs(sim - ref) / abs(ref) * 100)


def errs(sim, ref):
    diff = abs(sim - ref)
    r = 0.0 if ref == 0 else rel(sim, ref)
    if diff <= 0.01:
        return 100.0
    return max(100 * 0.01 / diff, r)


def band(pred, meas):
    e = abs(pred - meas) / meas
    return e, ("pass" if e <= 0.20 else "marginal" if e <= 0.35 else "fail")


def score_rung(p, m, set_name):
    s = dict(p50=rel(p["p50Ms"], m["p50Ms"]), p95=rel(p["p95Ms"], m["p95Ms"]),
             cpu=rel(p["appCpuPct"], m["appCpuPct"]), thr=rel(p["throughputRps"], m["throughputRps"]),
             err=errs(p["errorPct"] if set_name == "A" else p["totalLossPct"], m["totalLossPct"]))
    cost = None if m["costPerHour"] is None else rel(p["costPerHour"], m["costPerHour"])
    if cost is None:
        comp = sum(W[k] * s[k] for k in s) / 0.9
        label = "without cost (cost null; weights / 0.9)"
    else:
        s["cost"] = cost
        comp = sum(W[k] * s[k] for k in W)
        label = "with cost"
    e, b = band(p["p95Ms"], m["p95Ms"])
    out = dict(scores=s, composite=comp, compositeLabel=label, passes=comp >= 95,
               p95RelErr=e, p95Band=b, saturated=m["totalLossPct"] > 1)
    if set_name == "B":
        out["extras"] = dict(
            p99=dict(pred=p["p99Ms"], meas=m["p99Ms"], rel=rel(p["p99Ms"], m["p99Ms"])),
            dbCpu=dict(pred=p["dbCpuPct"], meas=m["dbCpuPct"], rel=rel(p["dbCpuPct"], m["dbCpuPct"])),
            dbConnections=dict(pred=p["dbConnections"], measAvg=m["dbConnectionsAvg"], measMax=m["dbConnectionsMax"],
                               rel=rel(p["dbConnections"], m["dbConnectionsAvg"])),
            hardErrors=dict(pred=p["hardErrorPct"], meas=m["hardErrorPct"], rel=rel(p["hardErrorPct"], m["hardErrorPct"])),
        )
    return out


def score(root, pred_path, out):
    preds = json.load(open(pred_path))
    summary = json.load(open(os.path.join(root, "SUMMARY.json")))
    measured, mismatches = {}, []
    for rep, attempt in REPS.items():
        assert summary["reps"][str(rep)]["attempt"] == attempt
        runner = {r["rps"]: r["summary"] for r in summary["reps"][str(rep)]["rungs"]}
        for rps in RUNGS:
            m = raw(os.path.join(root, "attempts", attempt), rps)
            measured[(rep, rps)] = m
            for k in ("p50Ms", "p95Ms", "p99Ms", "throughputRps", "totalLossPct", "hardErrorPct", "appCpuPct", "dbCpuPct"):
                if abs(m[k] - runner[rps][k]) > 1e-6:
                    mismatches.append(dict(rep=rep, rps=rps, field=k, recomputed=m[k], runner=runner[rps][k]))
            for k, rk in (("dbConnectionsAvg", "avg"), ("dbConnectionsMax", "max")):
                if abs(m[k] - runner[rps]["dbConnections"][rk]) > 1e-6:
                    mismatches.append(dict(rep=rep, rps=rps, field=k, recomputed=m[k], runner=runner[rps]["dbConnections"][rk]))
            if runner[rps]["costUsdPerHour"] is not None:
                mismatches.append(dict(rep=rep, rps=rps, field="cost", recomputed=None, runner=runner[rps]["costUsdPerHour"]))
    result = dict(campaign="oci-holdout-v1", sets={}, mismatchesVsRunnerSummary=mismatches)
    for set_name, key in (("A", "setA"), ("B", "setB")):
        rows = {}
        for (rep, rps), m in measured.items():
            rows[f"r{rep}-{rps}"] = score_rung(preds[key]["rungs"][str(rps)], m, set_name)
        cross = {}
        for rps in RUNGS:
            mean = {k: (measured[(1, rps)][k] + measured[(2, rps)][k]) / 2
                    for k in measured[(1, rps)]
                    if isinstance(measured[(1, rps)][k], (int, float)) and k not in ("rps", "n")}
            mean["costPerHour"] = None
            cross[str(rps)] = score_rung(preds[key]["rungs"][str(rps)], mean, set_name)
        result["sets"][set_name] = dict(
            rungs=rows, crossRepMean=cross,
            passingRungs=sum(r["passes"] for r in rows.values()), totalRungs=len(rows),
            verified=all(r["passes"] for r in rows.values()))
    os.makedirs(out, exist_ok=True)
    ser = {f"r{rep}-{rps}": m for (rep, rps), m in measured.items()}
    json.dump(ser, open(os.path.join(out, "measured.json"), "w"), indent=1)
    json.dump(result, open(os.path.join(out, "scores.json"), "w"), indent=1)
    with open(os.path.join(out, "measured.csv"), "w", newline="") as fh:
        cols = ["rep", "rps", "campaignId", "measurementSha", "steadyStartUtc", "steadyEndUtc", "n",
                "droppedIterations", "p50Ms", "p95Ms", "p99Ms", "throughputRps", "totalLossPct",
                "hardErrorPct", "appCpuNode0Pct", "appCpuNode1Pct", "appCpuPct", "dbCpuPct",
                "dbConnectionsAvg", "dbConnectionsMax", "monitoringPoints", "costPerHour"]
        w = csv.writer(fh)
        w.writerow(cols)
        for (rep, rps), m in measured.items():
            w.writerow([rep, rps] + [("null" if m[c] is None else m[c]) for c in cols[2:]])
    with open(os.path.join(out, "scores.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["set", "rep", "rps", "p50", "p95", "cpu", "throughput", "error", "cost",
                    "composite_without_cost", "passes", "p95_rel_err", "p95_band", "saturated",
                    "p99_rel", "db_cpu_rel", "db_conn_rel", "hard_err_rel"])
        for set_name in ("A", "B"):
            for key, r in list(result["sets"][set_name]["rungs"].items()) + \
                    [(f"mean-{k}", v) for k, v in result["sets"][set_name]["crossRepMean"].items()]:
                rep, rps = key.split("-")
                s, x = r["scores"], r.get("extras", {})
                w.writerow([set_name, rep, rps] + [round(s[k], 2) for k in ("p50", "p95", "cpu", "thr", "err")] +
                           ["null", round(r["composite"], 2), r["passes"], round(r["p95RelErr"], 4), r["p95Band"],
                            r["saturated"]] +
                           ([round(x[k]["rel"], 2) for k in ("p99", "dbCpu", "dbConnections", "hardErrors")] if x else [""] * 4))
    return result


if __name__ == "__main__":
    if sys.argv[1] == "raw":
        print(json.dumps(raw(sys.argv[2], int(sys.argv[3])), indent=1))
    else:
        r = score(sys.argv[2], sys.argv[3], sys.argv[4])
        for sn, sv in r["sets"].items():
            print("Set", sn, "verified" if sv["verified"] else "NOT verified", f"{sv['passingRungs']}/{sv['totalRungs']} rungs pass")
            for k, v in sv["rungs"].items():
                print("  ", k, round(v["composite"], 2), v["p95Band"], round(100 * v["p95RelErr"], 1))
        print("mismatches vs runner summary:", len(r["mismatchesVsRunnerSummary"]))
