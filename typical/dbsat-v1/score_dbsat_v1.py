#!/usr/bin/env python3
"""typical-dbsat-v1 verdict logic (PREREGISTRATION.md §6–§7).

Two layers:
  1. record_from_collect(): one adapter collect payload (+ k6 request
     samples) -> one per-rep, per-step record using the frozen §6.0
     aggregation (steady-window percentile / mean of 1-minute values / max of
     1-minute maxima; >2 missing minutes => metric not assessable).
  2. score(): records -> per-transition outcome (§7.3) and, when supplied,
     the confirmation result (§7.4). Engine predictions are never read here.

Interpretations the prereg leaves implicit are marked INTERPRETATION and
listed in INTERPRETATIONS so the report can print them.

Usage:
  score_dbsat_v1.py --records records.json [--out scores.json]
records.json: {"records": [ {...}, ... ], "confirmation": [ {...}, ... ]}
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import timedelta
from pathlib import Path

LADDER = [300, 500, 700, 900, 1100, 1300, 1500]
TRANSITIONS = [(2, 3), (3, 4)]

# §6.1
P95_RATIO = 1.45
ERR_PP = 0.01
ERR_RATIO = 2.0
TPUT_RATIO = 1.03
# §6.2
DB_CPU = 80.0
AAS = 2.0
CPU_SHARE = 0.60
IO_SHARE = 0.40
LOCK_SHARE = 0.40
AAS_MULT_300 = 3.0
CONN_CAP = 475
TMC_RATE = 0.001
DB_TIMEOUT_RATE = 0.001
# §6.3
APP_CPU = 70.0
NEAR_LIMIT_CPU = 60.0
GEN_CPU = 70.0
DROPPED = 0.005
NET_OUT = 0.70
ELB_5XX = 0.001
POOL_WAIT_MS = 10.0
QUEUE_FULL_RATE = 0.001
# §6.0
STEADY_MINUTES = 15
MAX_MISSING = 2
WARMUP_S = 300
STEADY_S = 900

INTERPRETATIONS = [
    "Mixed/uncertain 'partial DB evidence' (§6.3) = a pool signal with no §6.2 "
    "pressure while (i) db_timeout > 0.1% is present (unattributed timeout) or "
    "(ii) at least one §6.2 input is not assessable. No new numeric threshold "
    "is introduced.",
    "'Same type' of DB pressure in confirmation (§7.4c) = the confirmation "
    "pressure types intersect the types that held in both discovery reps.",
    "A §6.2/§6.3 input that is not assessable (§6.0 missing-minute rule) never "
    "satisfies a threshold; a step whose headroom is not assessable cannot "
    "serve as S*.",
    "When a candidate exists, a lower non-improving step that failed on "
    "headroom/pressure is listed as an observation; the candidate is the outcome.",
]


# ---------------------------------------------------------------------------
# §6.1 improvement


def error_ratio(err_n, err_n1):
    """E = err(N)/err(N+1) with the §6.1 zero rules. Returns (value, label)."""
    if err_n == 0 and err_n1 == 0:
        return 1.0, "1 (both zero)"
    if err_n1 == 0:
        return math.inf, "∞ (N+1 zero)"
    if err_n == 0:
        return 0.0, "0 (N zero)"
    return err_n / err_n1, None


def compare_pair(rec_n, rec_n1):
    """One paired comparison at one step. None when not comparable."""
    if rec_n is None or rec_n1 is None:
        return None
    s_n, s_n1 = rec_n["status"], rec_n1["status"]
    if s_n == "overload" and s_n1 == "complete":
        return {"improves": True, "reason": "N breached, N+1 complete (§6.1)", "comparable": True,
                "rp": None, "rt": None, "err_pp": None, "err_ratio": None, "err_ratio_label": None}
    if s_n != "complete" or s_n1 != "complete":
        return None
    rp = rec_n["steady_p95_ms"] / rec_n1["steady_p95_ms"]
    rt = rec_n1["achieved_rps"] / rec_n["achieved_rps"]
    pp = rec_n["error_rate"] - rec_n1["error_rate"]
    e, e_label = error_ratio(rec_n["error_rate"], rec_n1["error_rate"])
    by_p95 = rp > P95_RATIO
    by_err = pp > ERR_PP and e >= ERR_RATIO
    by_tput = rt > TPUT_RATIO
    return {
        "comparable": True,
        "improves": bool(by_p95 or by_err or by_tput),
        "by": [name for name, hit in (("p95", by_p95), ("errors", by_err), ("throughput", by_tput)) if hit],
        "rp": rp,
        "rt": rt,
        "err_pp": pp,
        "err_ratio": e,
        "err_ratio_label": e_label,
        "p95_change_pct": (1.0 / rp - 1.0) * 100.0,
    }


def classify_step(pairs):
    """§6.1 step classification from the two discovery pairs."""
    if any(p is None for p in pairs) or len(pairs) != 2:
        return "not comparable"
    hits = [p["improves"] for p in pairs]
    if all(hits):
        return "improves"
    if not any(hits):
        return "no improvement exceeding the threshold"
    return "inconclusive"


def geomean(values):
    vals = [v for v in values if v is not None and math.isfinite(v) and v > 0]
    if not vals:
        return None
    return math.exp(sum(math.log(v) for v in vals) / len(vals))


def summarise_pairs(pairs):
    real = [p for p in pairs if p and p.get("rp") is not None]
    rp = geomean([p["rp"] for p in real])
    pps = [p["err_pp"] for p in real]
    return {
        "rp_geomean": rp,
        "rt_geomean": geomean([p["rt"] for p in real]),
        "err_ratio_geomean": geomean([p["err_ratio"] for p in real]),
        "err_ratio_undefined_or_zero": [p["err_ratio_label"] for p in real if p["err_ratio_label"] and p["err_ratio"] in (0.0, math.inf)],
        "err_pp_mean": (sum(pps) / len(pps)) if pps else None,
        "p95_change_pct": ((1.0 / rp - 1.0) * 100.0) if rp else None,
    }


# ---------------------------------------------------------------------------
# §6.2 DB pressure


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def db_pressure(rec, aas_at_300=None):
    """Pressure types on one record. Returns dict with types / flags."""
    cpu = _num(rec.get("db_cpu_mean"))
    aas = _num(rec.get("pi_aas_mean"))
    shares = rec.get("wait_shares") or {}
    cpu_s, io_s, lock_s = _num(shares.get("cpu")), _num(shares.get("io")), _num(shares.get("lock"))
    conn = _num(rec.get("connections_max"))
    classes = rec.get("error_rates_by_class") or {}
    tmc = _num(classes.get("too_many_connections")) or 0.0
    dbt = _num(classes.get("db_timeout")) or 0.0
    types = []
    if (cpu is not None and cpu >= DB_CPU) or (aas is not None and cpu_s is not None and aas >= AAS and cpu_s >= CPU_SHARE):
        types.append("cpu")
    base = _num(aas_at_300)
    def share_rule(share, limit):
        if share is None or aas is None:
            return False
        if aas >= AAS and share >= limit:
            return True
        return base is not None and base > 0 and share >= limit and aas >= AAS_MULT_300 * base
    if share_rule(io_s, IO_SHARE):
        types.append("io")
    if share_rule(lock_s, LOCK_SHARE):
        types.append("lock")
    if (conn is not None and conn >= CONN_CAP) or tmc > TMC_RATE:
        types.append("connection-cap")
    corroborated = any(t in types for t in ("cpu", "io", "lock"))
    unattributed = dbt > DB_TIMEOUT_RATE and not corroborated
    if dbt > DB_TIMEOUT_RATE and corroborated:
        types.append("db_timeout (corroborated)")
    not_assessable = [name for name, v in (("db_cpu_mean", cpu), ("pi_aas_mean", aas), ("wait_shares", cpu_s), ("connections_max", conn)) if v is None]
    return {
        "pressure": bool(types),
        "types": types,
        "unattributed_timeout": unattributed,
        "not_assessable": not_assessable,
    }


# ---------------------------------------------------------------------------
# §6.3 headroom


def headroom_one(rec, pressure):
    reasons = []
    labels = []
    cpus = rec.get("app_cpu_by_node")
    if not cpus or any(_num(c) is None for c in cpus):
        reasons.append("app CPU not assessable")
        cpus = [c for c in (cpus or []) if _num(c) is not None]
    if any(c >= APP_CPU for c in cpus):
        reasons.append("app CPU ≥ 70%")
    gen = rec.get("generator") or {}
    gcpu, dropped, net = _num(gen.get("cpu_mean")), _num(gen.get("dropped_ratio")), _num(gen.get("network_out_ratio"))
    if gcpu is None or dropped is None or net is None:
        reasons.append("generator not assessable")
    if (gcpu is not None and gcpu >= GEN_CPU) or (dropped is not None and dropped > DROPPED) or (net is not None and net >= NET_OUT):
        reasons.append("generator invalid")
    elb = _num(rec.get("alb_elb_5xx_ratio"))
    if elb is None:
        reasons.append("ALB not assessable")
    elif elb > ELB_5XX or (_num(rec.get("target_connection_errors")) or 0) > 0:
        reasons.append("ALB errors")

    pool_p95 = rec.get("pool_wait_p95_ms")
    queue_full = _num((rec.get("error_rates_by_class") or {}).get("queue_full")) or 0.0
    mixed = False
    pool_attr = "not assessable" if pool_p95 is None else "none"
    pool_signal = (pool_p95 is not None and pool_p95 > POOL_WAIT_MS) or queue_full > QUEUE_FULL_RATE
    if pool_signal:
        near = any(c >= NEAR_LIMIT_CPU for c in cpus) or (gcpu is not None and gcpu >= NEAR_LIMIT_CPU)
        partial_db = (not pressure["pressure"]) and (pressure["unattributed_timeout"] or bool(pressure["not_assessable"]))
        if near or partial_db:
            pool_attr = "mixed/uncertain"
            mixed = True
        elif pressure["pressure"]:
            pool_attr = "pool waiting with DB pressure"
        else:
            pool_attr = "app pool limit"
            reasons.append("app pool limit")
    if pool_attr != "none":
        labels.append(pool_attr)
    return {"holds": not reasons and not mixed, "reasons": reasons, "pool_attribution": pool_attr,
            "mixed": mixed, "pool_not_assessable": pool_p95 is None, "labels": labels}


# ---------------------------------------------------------------------------
# Per-step evaluation and §7.3 outcome


def index_records(records):
    out = {}
    for rec in records:
        out[(rec["servers"], rec["rps"], rec["rep"])] = rec
    return out


def aas_300(idx, servers, rep):
    rec = idx.get((servers, 300, rep))
    return rec.get("pi_aas_mean") if rec and rec.get("status") == "complete" else None


def evaluate_step(idx, n, rps, reps):
    pairs = [compare_pair(idx.get((n, rps, r)), idx.get((n + 1, rps, r))) for r in reps]
    cls = classify_step(pairs)
    per_rep = []
    for r in reps:
        rec_n, rec_n1 = idx.get((n, rps, r)), idx.get((n + 1, rps, r))
        both_complete = bool(rec_n and rec_n1 and rec_n["status"] == "complete" and rec_n1["status"] == "complete")
        if not both_complete:
            per_rep.append({"rep": r, "complete": False,
                            "status_n": rec_n["status"] if rec_n else "not tested",
                            "status_n1": rec_n1["status"] if rec_n1 else "not tested"})
            continue
        p_n1 = db_pressure(rec_n1, aas_300(idx, n + 1, r))
        p_n = db_pressure(rec_n, aas_300(idx, n, r))
        h_n, h_n1 = headroom_one(rec_n, p_n), headroom_one(rec_n1, p_n1)
        per_rep.append({"rep": r, "complete": True, "pressure_n1": p_n1, "headroom_n": h_n, "headroom_n1": h_n1})
    complete = all(item["complete"] for item in per_rep)
    pressure_both = complete and all(item["pressure_n1"]["pressure"] for item in per_rep)
    headroom_both = complete and all(item["headroom_n"]["holds"] and item["headroom_n1"]["holds"] for item in per_rep)
    types_both = None
    if pressure_both:
        sets = [set(item["pressure_n1"]["types"]) for item in per_rep]
        types_both = sorted(set.intersection(*sets)) or sorted(set.union(*sets))
    return {
        "rps": rps,
        "complete_both": complete,
        "classification": cls,
        "pairs": pairs,
        "summary": summarise_pairs(pairs),
        "per_rep": per_rep,
        "db_pressure_both_reps": pressure_both,
        "pressure_types": types_both,
        "headroom_both_reps": headroom_both,
        "unattributed_timeout": complete and any(item["pressure_n1"]["unattributed_timeout"] for item in per_rep) and not pressure_both,
        "mixed": complete and any(item["headroom_n"]["mixed"] or item["headroom_n1"]["mixed"] for item in per_rep),
        "pool_not_assessable": complete and any(item["headroom_n"]["pool_not_assessable"] or item["headroom_n1"]["pool_not_assessable"] for item in per_rep),
        "qualifies_s_star": complete and cls == "no improvement exceeding the threshold" and pressure_both and headroom_both,
    }


def _non_improving_reason(step):
    if step["mixed"]:
        return "mixed/uncertain"
    if step["unattributed_timeout"]:
        return "unattributed timeout"
    return "app/other bottleneck"


def transition_outcome(records, n, reps=(1, 2)):
    idx = index_records(records)
    steps = [evaluate_step(idx, n, rps, list(reps)) for rps in LADDER]
    labels = {}
    for rps in LADDER:
        for servers in (n, n + 1):
            for r in reps:
                rec = idx.get((servers, rps, r))
                labels[f"{servers}x-{rps}-r{r}"] = (
                    "complete" if rec and rec["status"] == "complete"
                    else f"overload observation, {rec.get('overload_minutes')} min" if rec and rec["status"] == "overload"
                    else "not tested")
    result = {"transition": f"{n}→{n + 1}", "steps": steps, "step_labels": labels, "observations": []}
    s_star = next((s for s in steps if s["qualifies_s_star"]), None)
    first_non_improving = next((s for s in steps if s["complete_both"] and s["classification"] != "improves"), None)

    if s_star is not None:
        below = [s for s in steps if s["rps"] < s_star["rps"] and s["complete_both"] and s["classification"] == "improves"]
        between_floor = below[-1]["rps"] if below else None
        if first_non_improving is not None and first_non_improving["rps"] < s_star["rps"] and first_non_improving["classification"] != "inconclusive":
            result["observations"].append(f"{_non_improving_reason(first_non_improving)} signal at {first_non_improving['rps']} (below S*)")
        if below:
            s_prev = below[-1]
            result.update({
                "outcome": "candidate DB breakpoint",
                "range": [s_prev["rps"], s_star["rps"]],
                "s_prev": s_prev["rps"],
                "s_star": s_star["rps"],
                "pressure_types": s_star["pressure_types"],
                "between": [s["rps"] for s in steps if between_floor < s["rps"] < s_star["rps"]],
                "pool_attribution_not_assessable": s_star["pool_not_assessable"],
            })
            return result
        if s_star["rps"] == LADDER[0]:
            result.update({"outcome": "below tested range", "at": s_star["rps"], "pressure_types": s_star["pressure_types"]})
        else:
            result.update({"outcome": "DB pressure observed at X, no replica-benefit transition located",
                           "at": s_star["rps"], "pressure_types": s_star["pressure_types"]})
        return result

    if not any(s["complete_both"] for s in steps):
        result["outcome"] = "no comparable complete steps (not scored)"
        return result
    if first_non_improving is None:
        result["outcome"] = "no DB breakpoint established within tested range"
        result["reason"] = "every complete step improves"
        return result
    if first_non_improving["classification"] == "inconclusive":
        result.update({"outcome": "inconclusive", "at": first_non_improving["rps"]})
        return result
    reason = _non_improving_reason(first_non_improving)
    result.update({"outcome": reason, "at": first_non_improving["rps"]})
    return result


# ---------------------------------------------------------------------------
# §7.4 confirmation (single pair, never pooled)


def confirmation_outcome(candidate, conf_records, n):
    """candidate: transition_outcome() result with outcome 'candidate DB breakpoint'."""
    if candidate.get("outcome") != "candidate DB breakpoint":
        return {"result": "not triggered"}
    if any(rec.get("invalid") for rec in conf_records if rec["servers"] in (n, n + 1)):
        bad = [f"{r['servers']}x-{r['rps']}: {r.get('invalid')}" for r in conf_records if r.get("invalid")]
        return {"result": "invalid confirmation", "reasons": bad,
                "note": "Not a result. Replacement rules §7.7 apply (letter suffix, cap 6, pause-and-ask)."}
    idx = index_records([dict(rec, rep="c") for rec in conf_records])
    s_prev, s_star = candidate["s_prev"], candidate["s_star"]
    needed = [(srv, rps) for rps in (s_prev, s_star) for srv in (n, n + 1)]
    missing = [f"{srv}x-{rps}" for srv, rps in needed
               if not idx.get((srv, rps, "c")) or idx[(srv, rps, "c")]["status"] != "complete"]
    if missing:
        return {"result": "confirmation not completed due to overload", "steps_not_complete": missing,
                "completed": sorted(f"{k[0]}x-{k[1]}" for k, v in idx.items() if v["status"] == "complete")}
    prev = evaluate_step(idx, n, s_prev, ["c"])
    star = evaluate_step(idx, n, s_star, ["c"])
    a = bool(prev["pairs"][0] and prev["pairs"][0]["improves"])
    b = bool(star["pairs"][0] and not star["pairs"][0]["improves"])
    rep = star["per_rep"][0]
    conf_types = set(rep["pressure_n1"]["types"])
    c = bool(conf_types & set(candidate.get("pressure_types") or []))
    d = rep["headroom_n"]["holds"] and rep["headroom_n1"]["holds"]
    checks = {"a_s_prev_improves": a, "b_s_star_no_improvement": b, "c_same_pressure_type": c, "d_headroom": d}
    ok = all(checks.values())
    result = "confirmed" if ok else "candidate, not confirmed"
    if ok and (star["pool_not_assessable"] or candidate.get("pool_attribution_not_assessable")):
        result = "candidate (confirmed criteria met; capped: pool attribution not assessable)"
    return {"result": result, "checks": checks, "s_prev_pair": prev["pairs"][0], "s_star_pair": star["pairs"][0],
            "pressure_types": sorted(conf_types), "retry": "none (valid negative is final)" if not ok else None}


def score(records, confirmation=None):
    out = {"campaign": "typical-dbsat-v1", "interpretations": INTERPRETATIONS, "transitions": []}
    for n, _ in TRANSITIONS:
        t = transition_outcome([r for r in records if r["rep"] in (1, 2)], n)
        if confirmation is not None:
            t["confirmation"] = confirmation_outcome(t, confirmation, n)
        out["transitions"].append(t)
    return out


# ---------------------------------------------------------------------------
# §6.0 aggregation from adapter collect payloads


def _minute_values(metric, field, window):
    start, end = window
    values = {}
    for point in (metric or {}).get("datapoints") or []:
        stamp = point.get("timestamp")
        value = point.get(field)
        if stamp is None or value is None:
            continue
        from datetime import datetime, timezone
        at = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc)
        if start <= at < end:
            values[at.replace(second=0, microsecond=0)] = float(value)
    return values


def aggregate_minutes(values, how, expected=STEADY_MINUTES):
    """§6.0: >2 missing minutes => not assessable (None)."""
    if expected - len(values) > MAX_MISSING or not values:
        return None
    vals = list(values.values())
    return sum(vals) / len(vals) if how == "mean" else max(vals)


def record_from_collect(collect, samples=None, *, servers, rps, rep, expected_minutes=STEADY_MINUTES):
    """Build one §6.0 record. `samples` are (datetime, ms) k6 request samples."""
    here = Path(__file__).resolve().parent
    sys.path.insert(0, str(here.parent / "p95-v1"))
    import score_p95_v1 as p95  # noqa: E402  (same steady-window code, §4.1)

    window = p95.steady_window(collect)
    dbsat = collect.get("dbsat") or {}
    partial = (dbsat.get("partialStep") or {}).get("partial")
    if window and partial:
        minutes = (dbsat.get("partialStep") or {}).get("steadyMinutesObserved") or 0
        window = (window[0], window[0] + timedelta(minutes=minutes))
        expected_minutes = minutes
    metrics = (collect.get("cloudwatch") or {}).get("metrics") or {}
    app_cpu = [aggregate_minutes(_minute_values(m, "average", window), "mean", expected_minutes)
               for key, m in sorted(metrics.items()) if key.startswith("app_cpu_")]
    steady = dbsat.get("steadyP95") or {}
    per_minute = steady.get("perMinute") or []
    requests = sum(row.get("requests") or 0 for row in per_minute)
    failed = sum(row.get("failed") or 0 for row in per_minute)
    seconds = max(1, len(per_minute)) * 60 if partial else STEADY_S
    steady_p95 = p95.steady_only_p95(samples, window) if samples is not None else steady.get("steadyP95Ms")
    classes = collect.get("errorCategories") or {}
    pi = _pi_aggregate(dbsat.get("performanceInsights") or {}, window, expected_minutes)
    pool = _pool_p95(dbsat.get("poolMetrics") or {}, window)
    rec = {
        "servers": servers, "rps": rps, "rep": rep,
        "status": "overload" if partial else "complete",
        "overload_minutes": len(per_minute) if partial else None,
        "steady_p95_ms": steady_p95,
        "achieved_rps": requests / seconds if requests else None,
        "error_rate": (failed / requests) if requests else None,
        "error_rates_by_class": {k: (v / requests if requests else None) for k, v in classes.items() if isinstance(v, (int, float))},
        "app_cpu_by_node": app_cpu,
        "db_cpu_mean": aggregate_minutes(_minute_values(metrics.get("rds_cpu"), "average", window), "mean", expected_minutes),
        "connections_max": aggregate_minutes(_minute_values(metrics.get("rds_connections"), "maximum", window), "max", expected_minutes),
        "pi_aas_mean": pi["aas"],
        "wait_shares": pi["shares"],
        "pool_wait_p95_ms": pool,
        "generator": _generator(dbsat, metrics, window, expected_minutes, rps),
        "alb_elb_5xx_ratio": _alb_ratio(metrics, window),
        "target_connection_errors": _sum_minutes(((dbsat.get("cloudwatch") or {}).get("metrics") or {}).get("alb_target_connection_errors"), window),
    }
    return rec


# [FACT, AWS EC2 docs] c6i.xlarge baseline network bandwidth 1.5625 Gbit/s.
GENERATOR_BASELINE_BPS = 1.5625e9


def _sum_minutes(metric, window):
    if not metric or window is None:
        return None
    vals = _minute_values(metric, "sum", window)
    return sum(vals.values()) if vals else 0.0


def _alb_ratio(metrics, window):
    elb = _sum_minutes(metrics.get("alb_http_elb_5xx"), window)
    req = _sum_minutes(metrics.get("alb_request_count"), window)
    if elb is None or not req:
        return None
    return elb / req


def _generator(dbsat, metrics, window, expected, rps):
    extra = (dbsat.get("cloudwatch") or {}).get("metrics") or {}
    cpus, nets = [], []
    for key, metric in extra.items():
        if key.startswith("generator_cpu_"):
            cpus.append(aggregate_minutes(_minute_values(metric, "average", window), "mean", expected))
        elif key.startswith("generator_network_out_"):
            mean_bytes = aggregate_minutes(_minute_values(metric, "sum", window), "mean", expected)
            nets.append(None if mean_bytes is None else mean_bytes * 8 / 60 / GENERATOR_BASELINE_BPS)
    if not cpus:
        cpus = [aggregate_minutes(_minute_values(metrics.get("generator_cpu"), "average", window), "mean", expected)]
    steady = dbsat.get("steadyP95") or {}
    dropped = steady.get("droppedIterations")
    # §7.5: scheduled iterations = requested RPS × (150 s ramp-equivalent + 900 s).
    scheduled = rps * (150 + 900)
    worst = lambda vals: None if not vals or any(v is None for v in vals) else max(vals)
    return {
        "cpu_mean": worst(cpus),
        "dropped_ratio": (dropped / scheduled) if dropped is not None else None,
        "network_out_ratio": worst(nets),
    }


def _pi_aggregate(pi, window, expected):
    if not pi.get("available"):
        return {"aas": None, "shares": {}}
    from datetime import datetime, timezone
    start, end = window

    def minutes(points):
        out = {}
        for p in points:
            if p.get("value") is None:
                continue
            at = datetime.fromisoformat(str(p["timestamp"]).replace("Z", "+00:00")).astimezone(timezone.utc)
            if start <= at < end:
                out[at] = float(p["value"])
        return out

    total = None
    by_type = {}
    for series in pi.get("series") or []:
        dims = series.get("dimensions") or {}
        if not dims:
            total = minutes(series.get("datapoints") or [])
        else:
            by_type[dims.get("db.wait_event_type.name", "other")] = minutes(series.get("datapoints") or [])
    aas = aggregate_minutes(total or {}, "mean", expected)
    shares = {}
    if aas:
        for name, key in (("cpu", "CPU"), ("io", "IO"), ("lock", "Lock")):
            mean = aggregate_minutes(by_type.get(key, {}), "mean", expected)
            shares[name] = (mean / aas) if mean is not None else 0.0
    return {"aas": aas, "shares": shares}


def _pool_p95(pool, window):
    if not pool.get("available"):
        return None
    from datetime import datetime, timezone
    start, end = window
    buckets, total, ratio = {}, 0, 1.001
    for node in pool.get("nodes") or []:
        for row in node.get("minutes") or []:
            at = datetime.fromisoformat(row["minute"].replace("Z", "+00:00")).astimezone(timezone.utc)
            if not (start <= at < end):
                continue
            ratio = row.get("waitBucketRatio", ratio)
            for key, count in (row.get("waitBuckets") or {}).items():
                buckets[int(key)] = buckets.get(int(key), 0) + count
                total += count
    if not total:
        return None
    rank, seen = max(1, math.ceil(0.95 * total)), 0
    for key in sorted(buckets):
        seen += buckets[key]
        if seen >= rank:
            return ratio ** (key + 1)
    return None


def _jsonable(value):
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf"
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--records", required=True)
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    data = json.loads(Path(args.records).read_text())
    result = score(data["records"], data.get("confirmation"))
    text = json.dumps(_jsonable(result), indent=2, allow_nan=False)
    if args.out:
        Path(args.out).write_text(text + "\n")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
