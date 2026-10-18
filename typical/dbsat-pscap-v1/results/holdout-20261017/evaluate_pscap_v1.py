#!/usr/bin/env python3
"""typical-dbsat-pscap-v1 §5 evaluation: H1 / H0 / mixed, per rep, from rung-tables.json.

This is a lookup on the §4.2 tables using the frozen §5 rules (prereg §6). No new scorer.
Usage: evaluate_pscap_v1.py [--tables rung-tables.json] [--out verdict.json]

The §5 "invalid rep" rule is reported, not applied silently: rep validity is an input
(VALIDITY below), and both the retained-rep verdict and the strict alternative are printed.
"""
import argparse, json
from pathlib import Path

CAP = 65528
H0_B_LIMIT = 58975  # 90% of 65,528
LADDER = [300, 500, 700, 900, 1100, 1300, 1500]

# Validity inputs (prereg §5 "Invalid rep"). Rep 1 had a post-breach harness failure;
# the owner retained it as a disclosed exception (see README.md, "Validity decision").
VALIDITY = {
    "1": {"harness_failure": True, "retained_as_disclosed_exception": True},
    "2": {"harness_failure": False, "retained_as_disclosed_exception": False},
}


def rep_verdict(rep):
    rungs = rep["rungs"]
    last = rungs[-1]
    breached = last["step_status"] != "complete"
    B = last["rps"] if breached else None
    complete = [r for r in rungs if r["step_status"] == "complete"]
    final = complete[-1] if complete else None
    total_1461 = sum(r["mysql_1461_delta"] for r in rungs)
    c1 = total_1461 == 0 and all(r["mysql_1461_delta"] == 0 for r in rungs)
    c2 = B is None or B > 700
    stabilizes = final is not None and len(final["prepared_stmt_count_last5"]) == 5 and all(v < CAP for v in final["prepared_stmt_count_last5"])
    cap_rungs = [r for r in rungs if r["first_sample_at_cap_utc"]]
    cap_only_at_breach = bool(cap_rungs) and all(r["rps"] == B for r in cap_rungs)
    c3 = stabilizes or cap_only_at_breach
    h0a = B is not None and B <= 700 and total_1461 == 0
    # H0(b): a 1461 delta > 0 in a minute whose Prepared_stmt_count max < 58,975.
    # Evaluated per rung here; with zero 1461 deltas anywhere it cannot hold.
    h0b = any(r["mysql_1461_delta"] > 0 and r["prepared_stmt_count_peak"] < H0_B_LIMIT for r in rungs)
    if h0b is False and any(r["mysql_1461_delta"] > 0 for r in rungs):
        h0b = None  # needs the per-minute table; not decidable from rung totals
    h1 = c1 and c2 and c3
    verdict = "H1" if h1 else ("H0" if (h0a or h0b) else "mixed")
    return {
        "B": B, "mysql_1461_total": total_1461,
        "final_complete_rung": final["rps"] if final else None,
        "final_complete_rung_last5": final["prepared_stmt_count_last5"] if final else None,
        "prepared_stmt_count_max_whole_apply": rep["prepared_stmt_count_max_whole_apply"],
        "H1_1_no_1461": c1, "H1_2_breach_above_700": c2,
        "H1_3_stabilizes_below_cap": stabilizes, "H1_3_cap_only_at_breach": cap_only_at_breach,
        "H0a": h0a, "H0b": h0b, "measured_verdict": verdict,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tables", default="rung-tables.json")
    ap.add_argument("--out", default="verdict.json")
    a = ap.parse_args()
    tables = json.loads(Path(a.tables).read_text())
    reps = {k: rep_verdict(v) for k, v in sorted(tables.items())}
    for k, v in reps.items():
        v["validity"] = VALIDITY.get(k, {})
    measured = [v["measured_verdict"] for v in reps.values()]

    def campaign(valid_keys):
        vs = [reps[k]["measured_verdict"] for k in valid_keys]
        if len(vs) < 2:
            return "not decided (fewer than 2 valid reps)"
        if "H0" in vs:
            return "H0 (mechanism rejected)"
        if all(v == "H1" for v in vs):
            return "H1 (mechanism confirmed)"
        return "mixed / not decided"

    retained = [k for k, v in reps.items() if not v["validity"].get("harness_failure") or v["validity"].get("retained_as_disclosed_exception")]
    strict = [k for k, v in reps.items() if not v["validity"].get("harness_failure")]
    out = {
        "reps": reps,
        "measured_outcome_all_reps": measured,
        "campaign_verdict": campaign(retained),
        "campaign_verdict_basis": "rep 1 retained as a disclosed exception to the §5 invalid-rep rule",
        "strict_alternative": campaign(strict),
        "strict_alternative_basis": "blanket §5 exclusion of any rep with a harness failure",
    }
    text = json.dumps(out, indent=1)
    Path(a.out).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
