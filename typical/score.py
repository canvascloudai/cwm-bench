#!/usr/bin/env python3
"""Score the typical campaign against typical/PREDICTIONS.md.

Predictions are the engine 1.2.3 step-6 values in that file (section 2).
Cost is not in the collect JSON. The cost reference is the accuracy page's
list price for this topology, USD 0.4545 per hour, also recorded in
PREDICTIONS.md. That is an assumption, not a bill.

Run from the repository root:

    python3 typical/score.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAMPAIGN = ROOT / "typical" / "campaign" / "typical-v1-20260927c"
OUT = Path(__file__).resolve().parent / "scores.json"

# Section 2 of typical/PREDICTIONS.md.
pred = {
    20: dict(cpu=4.179, p50=19, p95=46, p99=117, thr=20, err=0.124, cost=0.49),
    100: dict(cpu=20, p50=18, p95=45, p99=148, thr=100, err=0.2, cost=0.62),
    200: dict(cpu=39.777, p50=18, p95=44, p99=190, thr=200, err=0.247, cost=0.78),
    300: dict(cpu=59.553, p50=17, p95=42, p99=236, thr=299, err=0.284, cost=0.94),
    500: dict(cpu=99.107, p50=15, p95=39, p99=341, thr=450, err=9.954, cost=1.18),
}
keys = {
    20: "fit-20",
    100: "fit-100",
    200: "fit-200",
    300: "holdout-300",
    500: "saturation-500",
}
REFCOST = 0.4545
W = dict(p50=0.20, p95=0.25, cpu=0.20, thr=0.15, err=0.10, cost=0.10)


def rel(simulated, reference):
    if reference == 0:
        return 100.0
    return max(0, 100 - abs(simulated - reference) / abs(reference) * 100)


def errs(simulated, reference):
    # Reference 0: relative accuracy treated as 0 (PREDICTIONS.md section 4).
    difference = abs(simulated - reference)
    relative = 0 if reference == 0 else rel(simulated, reference)
    if difference <= 0.01:
        return 100.0
    return max(100 * 0.01 / difference, relative)


def main():
    out = {}
    for rps, key in keys.items():
        path = CAMPAIGN / f"11-typical-{key}.collect.json"
        collected = json.loads(path.read_text())
        app = [node["cpuAvgPct"] for node in collected["perNode"] if node["role"] == "app"]
        measured = dict(
            cpu=sum(app) / len(app),
            p50=collected["latency"]["p50Ms"],
            p95=collected["latency"]["p95Ms"],
            p99=collected["latency"]["p99Ms"],
            thr=collected["goodputRps"],
            err=collected["artifacts"]["k6"]["httpReqFailed"]["rate"] * 100,
            cost=REFCOST,
            alb50=collected["albLatency"]["p50Ms"],
            alb95=collected["albLatency"]["p95Ms"],
            alb99=collected["albLatency"]["p99Ms"],
            albrps=collected["cloudwatch"]["metrics"]["alb_request_count"]["summary"]["value"] / 780,
            db=[node["cpuAvgPct"] for node in collected["perNode"] if node["role"] == "database"][0],
        )
        predicted = pred[rps]
        scores = {name: round(rel(predicted[name], measured[name]), 1) for name in ["p50", "p95", "cpu", "thr", "cost"]}
        scores["err"] = round(errs(predicted["err"], measured["err"]), 1)
        total = sum(W[name] * scores[name] for name in W)
        without_cost = sum(W[name] * scores[name] for name in W if name != "cost") / 0.9
        out[rps] = dict(
            m=measured,
            s=scores,
            total=round(total, 1),
            total_excl_cost=round(without_cost, 1),
            p99=round(rel(predicted["p99"], measured["p99"]), 1),
        )
        print(rps, {name: round(value, 3) for name, value in measured.items()})
        print("   scores", scores, "total", round(total, 1), "excl cost", round(without_cost, 1))
    # JSON object keys are strings. Match the published scores file.
    encoded = {str(rps): row for rps, row in out.items()}
    OUT.write_text(json.dumps(encoded, indent=1) + "\n")


if __name__ == "__main__":
    main()
