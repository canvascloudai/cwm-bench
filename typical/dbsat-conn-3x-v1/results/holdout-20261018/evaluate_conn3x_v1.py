#!/usr/bin/env python3
"""typical-dbsat-conn-3x-v1 evaluation: per-rep H1 / H0 / mixed and campaign verdict.

Strict lookup on the frozen PREREGISTRATION.md §5.3 (hypotheses) and §5.4 (validity), using
rung-tables.json (build_rung_tables.py) and records.json (build_records.py). No new scorer,
no thresholds other than the preregistered ones.

Usage: evaluate_conn3x_v1.py EVIDENCE_DIR [--tables rung-tables.json] [--records records.json]
                             [--out verdict.json]
"""
import argparse, json
from datetime import datetime
from pathlib import Path

CAP = 65528
MAXCONN_REQUIRED = 500
SERVER_LIMIT_FRACTION = 0.98
TMC_SHARE_H1 = 0.50
ERR_CRITERION = 0.05
B_STAR = 700
E5_BREACH_DROPPED_MAX = 0.005
E4_MAX_CONSEC = 2
E4_MAX_FRACTION = 0.10


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def validity(rep_t, apply, raw_verif, rep_recs):
    """§5.4. Returns dict of E1..E5 + parameter checks + failure-timing check."""
    wr = rep_t["wait_ready"]
    decl = rep_t["breach_declared_utc"]
    rungs = rep_t["rungs"]
    B = next((r["rps"] for r in rungs if r["breach_declared_utc"]), None)
    through = [r for r in rungs if B is None or r["rps"] <= B]
    e1 = wr.get("actualSqlRead") is True and wr.get("max_prepared_stmt_count") is not None and wr.get("max_connections") is not None
    e2 = all(r["monitor_minutes"] > 0 for r in through) and (B is None or any(r["breach_declared_utc"] for r in through))
    camp = apply["campaign"]
    verified = {v["file"]: v for v in raw_verif}
    e3_files = []
    for r in through:
        hit = [v for f, v in verified.items() if f.startswith(f"out/{camp}/rungs/typical-dbsat-3x-{r['rps']}-")]
        e3_files.append(bool(hit) and all(h["gzipIntegrityVerified"] and h["matchesOriginalTransfer"] for h in hit))
    e3 = all(e3_files)
    e4d = rep_t["E4_polling"]
    if e4d is None:
        e4 = None  # no breach: §5.4 E4 window is defined relative to the declaration
    else:
        e4 = (e4d["breach_rung_to_decl_plus_60s"]["max_consecutive_missing"] <= E4_MAX_CONSEC
              and e4d["first_rung_to_decl_plus_60s"]["missing_fraction"] <= E4_MAX_FRACTION)
    pre = [rg for rg in apply["rungs"] if B is None or rg["rate"] < B]
    e5_pre = all(rg.get("generatorValid") is True for rg in pre)
    e5_breach = None
    breach_drop = None
    if B is not None:
        brg = next(rg for rg in apply["rungs"] if rg["rate"] == B)
        tmc = brg.get("tooManyConnections") or {}
        rec = next((x for x in rep_recs if x["rps"] == B), {})
        breach_drop = {
            "controller_dropped": tmc.get("droppedIterations"),
            "controller_scheduled_full_step": tmc.get("scheduledIterations"),
            "controller_fraction": tmc.get("droppedFraction"),
            "k6_dropped": rec.get("k6_dropped_iterations"),
            "k6_iterations_completed": rec.get("k6_iterations"),
        }
        if rec.get("k6_iterations") is not None and rec.get("k6_dropped_iterations") is not None:
            sched_to_stop = rec["k6_iterations"] + rec["k6_dropped_iterations"]
            breach_drop["scheduled_until_stop"] = sched_to_stop
            breach_drop["fraction_of_scheduled_until_stop"] = rec["k6_dropped_iterations"] / sched_to_stop
        frac = tmc.get("droppedFraction")
        e5_breach = frac is not None and frac <= E5_BREACH_DROPPED_MAX
        breach_drop["strict_until_stop_ok"] = (breach_drop.get("fraction_of_scheduled_until_stop") is None
                                               or breach_drop["fraction_of_scheduled_until_stop"] <= E5_BREACH_DROPPED_MAX)
    e5 = e5_pre and (e5_breach is not False)
    p_mpsc = wr.get("max_prepared_stmt_count") == CAP and rep_t["limit_values_seen"] == [CAP]
    p_mc = wr.get("max_connections") == MAXCONN_REQUIRED
    # Failures: the only recorded non-complete outcomes are the breach stop itself and the
    # recovery rule result, which starts after the declaration. Any problem record would be
    # listed in campaign-execution.json; none is present.
    problems = [p for p in apply.get("problems", [])]
    pre_breach_failures = [p for p in problems if decl and p.get("at") and ts(p["at"]) < ts(decl)]
    return {
        "E1_wait_ready_variables": e1, "E2_breach_monitor_rows": e2, "E3_raw_k6_hash_verified": e3,
        "E3_per_rung": dict(zip([r["rps"] for r in through], e3_files)),
        "E4_polling": e4, "E4_detail": e4d,
        "E5_generator_pre_breach": e5_pre, "E5_breach_rung_dropped_ok": e5_breach,
        "E5_breach_rung_detail": breach_drop, "E5": e5,
        "max_prepared_stmt_count_65528": p_mpsc, "max_connections_500": p_mc,
        "recorded_max_connections": wr.get("max_connections"),
        "problem_records": problems, "failures_before_breach": pre_breach_failures,
        "recovery_outcome": next((rg.get("recovery") for rg in apply["rungs"] if rg.get("recovery")), None),
        "valid": bool(e1 and e2 and e3 and (e4 is not False) and e5 and p_mpsc and p_mc and not pre_breach_failures),
        # Sensitivity only (not the preregistered rule): E5 on the breach rung with the
        # denominator = iterations scheduled until the stop (k6 completed + dropped).
        "valid_if_E5_denominator_is_scheduled_until_stop": bool(
            e1 and e2 and e3 and (e4 is not False) and e5_pre
            and (breach_drop is None or breach_drop["strict_until_stop_ok"])
            and p_mpsc and p_mc and not pre_breach_failures),
    }


def hypotheses(rep_t, rep_recs):
    rungs = rep_t["rungs"]
    B = next((r["rps"] for r in rungs if r["breach_declared_utc"]), None)
    total_1461 = sum(r["mysql_1461_delta"] for r in rungs)
    any_cap = any(r["any_prepared_at_or_above_cap"] for r in rungs)
    maxconn = rep_t["wait_ready"].get("max_connections")
    thr = SERVER_LIMIT_FRACTION * maxconn if maxconn else None
    upto = [r for r in rungs if B is None or r["rps"] <= B]
    reached_by = next((r["rps"] for r in upto if thr is not None and r["threads_connected_max"] >= thr), None)
    brung = next((r for r in rungs if r["rps"] == B), None)
    err_crit = brung is not None and brung["breach_minutes"] is not None and len(brung["breach_minutes"]) == 3 and \
        all(m["errorRate"] is not None and m["errorRate"] > ERR_CRITERION for m in brung["breach_minutes"])
    brec = next((x for x in rep_recs if x["rps"] == B), None)
    tmc_share = brec["tmc_share_of_failures"] if brec else None
    h1 = {
        "1_B_eq_700": B == B_STAR,
        "2_error_criterion": bool(err_crit),
        "3_tmc_share_gt_50pct": tmc_share is not None and tmc_share > TMC_SHARE_H1,
        "4_no_1461": total_1461 == 0,
        "5_server_limit_by_700": reached_by is not None and reached_by <= B_STAR,
        "6_prepared_below_cap": not any_cap,
    }
    h0 = {
        "a_B_le_500": B is not None and B <= 500,
        "b_no_breach_at_700": B is None or B > B_STAR,
        "c_B700_not_connections": B == B_STAR and not (h1["3_tmc_share_gt_50pct"] and h1["5_server_limit_by_700"]),
        "d_any_1461": total_1461 > 0,
        "e_prepared_at_or_above_cap": any_cap,
    }
    verdict = "H1" if all(h1.values()) else ("H0" if any(h0.values()) else "mixed")
    return {
        "B": B, "B_label": "none" if B is None else B,
        "breach_declared_utc": rep_t["breach_declared_utc"],
        "breach_minutes": brung["breach_minutes"] if brung else None,
        "breach_on_error_criterion": bool(err_crit),
        "tmc_share_at_breach_rung": tmc_share,
        "mysql_1461_total": total_1461,
        "server_limit_threshold": thr, "server_limit_first_reached_rung": reached_by,
        "prepared_stmt_count_max_whole_apply": rep_t["prepared_stmt_count_max_whole_apply"],
        "H1_conditions": h1, "H0_conditions": h0, "measured_verdict": verdict,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evidence")
    ap.add_argument("--tables", default="rung-tables.json")
    ap.add_argument("--records", default="records.json")
    ap.add_argument("--out", default="verdict.json")
    a = ap.parse_args()
    root = Path(a.evidence)
    tables = json.loads(Path(a.tables).read_text())
    recs = json.loads(Path(a.records).read_text())["records"]
    ce = json.loads((root / "campaign-execution.json").read_text())
    raw = json.loads((root / "RAW-GZIP-VERIFICATION.json").read_text())
    applies = {ap_["campaign"]: ap_ for ap_ in ce["applies"]}
    reps = {}
    for k, t in sorted(tables.items()):
        rr = [x for x in recs if str(x["rep"]) == k]
        v = hypotheses(t, rr)
        v["validity"] = validity(t, applies[t["campaign"]], raw, rr)
        reps[k] = v
    def campaign(valid):
        vs = [reps[k]["measured_verdict"] for k in valid]
        if len(valid) < 2:
            return "not decided (fewer than 2 valid reps)"
        if all(x == "H1" for x in vs):
            return "H1"
        if all(x == "H0" for x in vs):
            return "H0"
        return "not decided (reps disagree or a rep is mixed)"

    valid = [k for k, v in reps.items() if v["validity"]["valid"]]
    alt = [k for k, v in reps.items() if v["validity"]["valid_if_E5_denominator_is_scheduled_until_stop"]]
    out = {"prereg": "typical/dbsat-conn-3x-v1/PREREGISTRATION.md §5.3/§5.4", "reps": reps,
           "valid_reps": valid, "campaign_verdict": campaign(valid),
           "measured_outcome_all_reps": {k: v["measured_verdict"] for k, v in reps.items()},
           "sensitivity_E5_scheduled_until_stop": {
               "basis": "not the preregistered rule; §5.4 E5 cites dbsat-v1 §7.5, scheduled = RPS x 1050 s",
               "valid_reps": alt, "campaign_verdict": campaign(alt),
               "note": "an invalid rep is not a result (§5.4) and would go to the §7.2 replacement rules"}}
    text = json.dumps(out, indent=1, default=str)
    Path(a.out).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
