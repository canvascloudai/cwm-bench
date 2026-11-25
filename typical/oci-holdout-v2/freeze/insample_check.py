#!/usr/bin/env python3
"""In-sample check of the oci-holdout-v2 frozen predictions (pre-registration evidence only).

Scores freeze/predictions.json against oci-holdout-v1 r1/r2 (the fit data) with the
v1 rule and with the v2 rule (adds the 1 pp absolute app-CPU tolerance). In-sample
scores are NOT a holdout result; they show what each rule does on the fit data.

    python3 typical/oci-holdout-v2/freeze/insample_check.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEASURED = HERE.parents[1] / "oci-holdout-v1" / "results" / "holdout-20261124" / "measured.json"
W = dict(p50=0.20, p95=0.25, cpu=0.20, thr=0.15, err=0.10)  # cost null -> /0.9
CPU_ABS_TOLERANCE_PP = 1.0


def rel(sim, ref):
    if ref == 0:
        return 100.0 if sim == 0 else 0.0
    return max(0.0, 100 - abs(sim - ref) / abs(ref) * 100)


def errs(sim, ref):
    diff = abs(sim - ref)
    if diff <= 0.01:
        return 100.0
    return max(100 * 0.01 / diff, 0.0 if ref == 0 else rel(sim, ref))


def cpu_score(sim, ref, tolerance):
    if tolerance and abs(sim - ref) <= CPU_ABS_TOLERANCE_PP:
        return 100.0
    return rel(sim, ref)


def main():
    pred = {r["offeredRps"]: r for r in json.loads((HERE / "predictions.json").read_text())["rungs"]}
    measured = json.loads(MEASURED.read_text())
    out = []
    for key, m in measured.items():
        p = pred[m["rps"]]
        row = {"rep": key.split("-")[0], "rps": m["rps"]}
        for label, tol in (("v1Rule", False), ("v2Rule", True)):
            s = dict(
                p50=rel(p["latencyP50Ms"], m["p50Ms"]),
                p95=rel(p["latencyP95Ms"], m["p95Ms"]),
                cpu=cpu_score(p["appCpuPctPerNode"], m["appCpuPct"], tol),
                thr=rel(p["throughputRps"], m["throughputRps"]),
                err=errs(p["totalLossPct"], m["totalLossPct"]),
            )
            row[label] = round(sum(W[k] * v for k, v in s.items()) / 0.9, 2)
        row["cpuAbsDiffPp"] = round(abs(p["appCpuPctPerNode"] - m["appCpuPct"]), 3)
        row["p95RelErrPct"] = round(abs(p["latencyP95Ms"] - m["p95Ms"]) / m["p95Ms"] * 100, 2)
        out.append(row)
    print(f"{'rep':4} {'rps':>5} {'v1 rule':>8} {'v2 rule':>8} {'|dCPU| pp':>10} {'P95 err %':>10}")
    for r in out:
        print(f"{r['rep']:4} {r['rps']:>5} {r['v1Rule']:>8.2f} {r['v2Rule']:>8.2f} {r['cpuAbsDiffPp']:>10.3f} {r['p95RelErrPct']:>10.2f}")
    (HERE / "insample-scores.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
