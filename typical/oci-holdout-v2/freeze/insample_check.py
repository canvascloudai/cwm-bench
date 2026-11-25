#!/usr/bin/env python3
"""In-sample and cross-rep check of the oci-holdout-v2 scoring rule (pre-registration evidence only).

Scores freeze/predictions.json against oci-holdout-v1 r1/r2 (the FIT data), and scores
one v1 rep as a predictor of the other (cross-rep), under:
  v1Rule    - the oci-holdout-v1 composite, unchanged
  finalRule - the oci-holdout-v2 composite (absolute tolerances declared in PREREGISTRATION.md)
In-sample scores are NOT a holdout result.

    python3 typical/oci-holdout-v2/freeze/insample_check.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEASURED = HERE.parents[1] / "oci-holdout-v1" / "results" / "holdout-20261124" / "measured.json"
W = dict(p50=0.20, p95=0.25, cpu=0.20, thr=0.15, err=0.10)  # cost null -> divide by 0.9

# oci-holdout-v2 absolute tolerances (score 100 inside; otherwise the v1 rule).
LATENCY_ABS_MS = 0.5        # P50, P95 (composite); P99 (extra)
APP_CPU_ABS_PP = 1.0        # app CPU % (mean of the two app nodes)
LOSS_ABS_PP = 0.05          # total loss % (scored error)
THROUGHPUT_REL_PCT = 0.5    # throughput RPS
DB_CPU_ABS_PP = 2.0         # extra only, not in the composite
DB_CONN_ABS = 5.0           # extra only, not in the composite


def rel(sim, ref):
    if ref == 0:
        return 100.0 if sim == 0 else 0.0
    return max(0.0, 100 - abs(sim - ref) / abs(ref) * 100)


def errs(sim, ref):
    diff = abs(sim - ref)
    if diff <= 0.01:
        return 100.0
    return max(100 * 0.01 / diff, 0.0 if ref == 0 else rel(sim, ref))


def within_abs(sim, ref, tol, fallback):
    return 100.0 if abs(sim - ref) <= tol + 1e-12 else fallback(sim, ref)


def components(p, m, final):
    if not final:
        return dict(p50=rel(p["p50"], m["p50"]), p95=rel(p["p95"], m["p95"]), cpu=rel(p["cpu"], m["cpu"]),
                    thr=rel(p["thr"], m["thr"]), err=errs(p["err"], m["err"]))
    thr_ok = m["thr"] != 0 and abs(p["thr"] - m["thr"]) / m["thr"] * 100 <= THROUGHPUT_REL_PCT
    return dict(
        p50=within_abs(p["p50"], m["p50"], LATENCY_ABS_MS, rel),
        p95=within_abs(p["p95"], m["p95"], LATENCY_ABS_MS, rel),
        cpu=within_abs(p["cpu"], m["cpu"], APP_CPU_ABS_PP, rel),
        thr=100.0 if thr_ok else rel(p["thr"], m["thr"]),
        err=within_abs(p["err"], m["err"], LOSS_ABS_PP, errs),
    )


def composite(p, m, final):
    s = components(p, m, final)
    return round(sum(W[k] * v for k, v in s.items()) / 0.9, 2), s


def extras(p, m, final):
    f = (lambda tol: (lambda a, b: within_abs(a, b, tol, rel))) if final else (lambda tol: rel)
    return dict(p99=round(f(LATENCY_ABS_MS)(p["p99"], m["p99"]), 2),
                dbCpu=round(f(DB_CPU_ABS_PP)(p["db"], m["db"]), 2),
                dbConn=round(f(DB_CONN_ABS)(p["conn"], m["conn"]), 2))


def from_measured(m):
    return dict(p50=m["p50Ms"], p95=m["p95Ms"], p99=m["p99Ms"], cpu=m["appCpuPct"], thr=m["throughputRps"],
                err=m["totalLossPct"], db=m["dbCpuPct"], conn=m["dbConnectionsAvg"])


def main():
    pred = {}
    for r in json.loads((HERE / "predictions.json").read_text())["rungs"]:
        pred[r["offeredRps"]] = dict(p50=r["latencyP50Ms"], p95=r["latencyP95Ms"], p99=r["latencyP99Ms"],
                                     cpu=r["appCpuPctPerNode"], thr=r["throughputRps"], err=r["totalLossPct"],
                                     db=r["dbCpuPct"], conn=r["dbConnections"])
    measured = {k: from_measured(v) | {"rps": v["rps"]} for k, v in json.loads(MEASURED.read_text()).items()}
    rows = []
    for key, m in measured.items():
        rep, rps = key.split("-")[0], m["rps"]
        cases = [("in-sample (frozen prediction)", pred[rps])]
        other = measured[("r2" if rep == "r1" else "r1") + f"-{rps}"]
        cases.append((f"cross-rep ({'r2' if rep == 'r1' else 'r1'} predicts {rep})", other))
        for label, p in cases:
            v1, _ = composite(p, m, False)
            fin, comps = composite(p, m, True)
            rows.append(dict(case=label, rep=rep, rps=rps, v1Rule=v1, finalRule=fin,
                             finalComponents={k: round(x, 2) for k, x in comps.items()},
                             absDiff=dict(p50Ms=round(abs(p["p50"] - m["p50"]), 3), p95Ms=round(abs(p["p95"] - m["p95"]), 3),
                                          appCpuPp=round(abs(p["cpu"] - m["cpu"]), 3)),
                             extrasV1Rule=extras(p, m, False), extrasFinalRule=extras(p, m, True)))
    for case in ("in-sample", "cross-rep"):
        sel = [r for r in rows if r["case"].startswith(case)]
        print(f"\n{case}: {'rep':4} {'rps':>5} {'v1':>7} {'final':>7}  final components")
        for r in sel:
            print(f"{'':11}{r['rep']:4} {r['rps']:>5} {r['v1Rule']:>7.2f} {r['finalRule']:>7.2f}  {r['finalComponents']}  {r['absDiff']}")
        print(f"{'':11}min v1 {min(r['v1Rule'] for r in sel):.2f}  min final {min(r['finalRule'] for r in sel):.2f}")
    (HERE / "insample-scores.json").write_text(json.dumps(rows, indent=1) + "\n")


if __name__ == "__main__":
    main()
