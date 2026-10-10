#!/usr/bin/env python3
"""Score typical-p95-v1 from local files only.

Candidate centrals come from predictions/model-predictions.csv.
Engine centrals come from predictions/engine-baseline/predictions.json.
This script does not query a live engine and does not refit.

Usage:
  python3 typical/p95-v1/score_p95_v1.py --dry-run --out /tmp/p95-v1-dry-run.json
  python3 typical/p95-v1/score_p95_v1.py --evidence DIR --predictions CSV --engine JSON --out FILE
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import re
import statistics
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# §7.2 acceptance tolerances. Not predictive intervals.
TOL_LOW = 0.666
TOL_HIGH = 1.432
# §7.4 server-change tolerances.
SERVER_TOL = {300: 1.6, 200: 1.6, 100: 1.3}
DIRECTION_MIN_RATIO = 1.25
PAGE_MIN = 80
CELLS_IN_TOL_MIN = 8
REPLACEMENT_BUDGET = 6
SPEND_CAP_USD = 40.0
GEN_CPU_MAX = 70.0
DROPPED_FRACTION = 0.005
RAMP_EQUIV_S = 150
STEADY_S = 900
WARMUP_S = 300
STEADY_MINUTES = 15
CW_MISSING_MINUTES = 2

CELLS = tuple((n, rps) for n in (1, 2, 3) for rps in (300, 200, 100))
# §5.3 scale-v1 medians, rounded to 0.1 ms. Reproduced from the campaign collects.
SCALE_V1_P95_MEDIANS = {
    (1, 300): 95.0,
    (1, 200): 37.5,
    (1, 100): 9.1,
    (2, 300): 41.3,
    (2, 200): 15.1,
    (2, 100): 8.4,
    (3, 300): 20.7,
    (3, 200): 12.1,
    (3, 100): 8.7,
}
SCALE_V1_SESSIONS = {
    1: {1: "typical-scale-1x-r1-20261006", 2: "typical-scale-2x-r1-20261006", 3: "typical-scale-3x-r1-20261006"},
    2: {1: "typical-scale-1x-r2-20261007", 2: "typical-scale-2x-r2-20261007", 3: "typical-scale-3x-r2-20261007"},
    3: {1: "typical-scale-1x-r3-20261009", 2: "typical-scale-2x-r3-20261009", 3: "typical-scale-3x-r3a-20261009"},
}

P95_KEY_RE = re.compile(r"^typical-p95-(1x|2x|3x)-(300|200|100)$")
REUSED_KEY_RE = re.compile(r"^typical-(?:fit|holdout|scale)-")
APPLY_RE = re.compile(r"^typical-p95-(1x|2x|3x)-r([1-3])([a-z]?)-\d{8}$")
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def cell_id(servers, rps):
    return f"{servers}x-{rps}"


def page_score(measured, predicted):
    """§7.1. None when the measured value cannot be a denominator."""
    if measured is None or predicted is None or measured == 0:
        return None
    return 100.0 - 100.0 * abs(measured - predicted) / measured


def acceptance_bounds(central):
    return (central * TOL_LOW, central * TOL_HIGH)


def in_tolerance(measured, central):
    low, high = acceptance_bounds(central)
    return measured is not None and low <= measured <= high


def preallocated_vus(rps):
    """Same steps as load/lib/common.js vuBudget."""
    if rps <= 10:
        return 20
    if rps <= 100:
        return 80
    if rps <= 500:
        return 400
    return 800


def scheduled_iterations(rps):
    return rps * (RAMP_EQUIV_S + STEADY_S)


def load_model_predictions(path):
    """Candidate centrals. The CSV is the source of truth, not a live formula."""
    rows = {}
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            servers = int(row["servers"])
            rps = int(row["total_rps"])
            rows[(servers, rps)] = float(row["model_p95_ms"])
    missing = [cell_id(*cell) for cell in CELLS if cell not in rows]
    if missing:
        raise SystemExit(f"model predictions missing cells: {', '.join(missing)}")
    return rows


def load_engine_predictions(path):
    """Frozen engine file. Missing file means the baseline is not frozen."""
    if path is None or not Path(path).is_file():
        return None
    payload = json.loads(Path(path).read_text())
    cells = payload.get("cells") or {}
    out = {}
    for servers, rps in CELLS:
        raw = cells.get(cell_id(servers, rps))
        if isinstance(raw, dict) and raw.get("latencyP95") is not None:
            out[(servers, rps)] = float(raw["latencyP95"])
        else:
            out[(servers, rps)] = None
    return {
        "engineVersion": payload.get("engineVersion"),
        "calibrationId": payload.get("calibrationId"),
        "cells": out,
    }


def scale_v1_p95_medians(repo):
    """Median k6 p95 from the scored typical-scale-v1 applies. Local files only."""
    root = Path(repo) / "typical/campaign/typical-scale-v1-20261006"
    medians = {}
    for servers, rps in CELLS:
        values = []
        for session, applies in SCALE_V1_SESSIONS.items():
            apply_id = applies[servers]
            path = root / apply_id / f"11-typical-scale-{servers}x-{rps}.collect.json"
            payload = json.loads(path.read_text())
            values.append(payload["latency"]["p95Ms"])
        medians[(servers, rps)] = round(statistics.median(values), 1)
    return medians


def _parse_time(value):
    if not value or not isinstance(value, str):
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def steady_window(collect):
    window = ((collect.get("cloudwatch") or {}).get("window") or {})
    start = _parse_time(window.get("actualStartTime"))
    if start is None:
        start = _parse_time(collect.get("startedAt"))
    if start is None:
        return None
    steady_start = start + timedelta(seconds=WARMUP_S)
    return steady_start, steady_start + timedelta(seconds=STEADY_S)


def _percentile(values, pct):
    """Nearest-rank percentile. Descriptive. Never averaged from per-minute p95s."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]


def read_request_samples(path):
    """k6 --out json NDJSON, or k6 CSV, plain or gzipped."""
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    samples = []
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        first = handle.readline()
        if not first:
            return samples
        stripped = first.lstrip()
        if stripped.startswith("{") or stripped.startswith("["):
            lines = [first]
            lines.extend(handle)
            for line in lines:
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "Point" or obj.get("metric") != "http_req_duration":
                    continue
                data = obj.get("data") or {}
                if "value" not in data:
                    continue
                samples.append((_parse_time(data.get("time")), float(data["value"])))
            return samples
        # CSV: header plus the first data row already consumed only if it was a header.
        handle.seek(0)
        reader = csv.DictReader(handle)
        for row in reader:
            name = row.get("metric_name") or row.get("metric")
            if name != "http_req_duration":
                continue
            raw = row.get("metric_value") or row.get("value")
            if raw is None or raw == "":
                continue
            stamp = row.get("timestamp") or row.get("time")
            samples.append((_parse_time(stamp), float(raw)))
    return samples


def steady_only_p95(samples, window):
    if window is None:
        return None
    start, end = window
    values = [value for stamp, value in samples if stamp is not None and start <= stamp < end]
    return _percentile(values, 95)


def per_minute_p95(samples, window):
    """Per-minute p95 series. Not an input to the scored percentile."""
    if window is None:
        return []
    start, end = window
    buckets = {}
    for stamp, value in samples:
        if stamp is None or stamp < start or stamp >= end:
            continue
        minute = stamp.replace(second=0, microsecond=0).strftime("%H:%M")
        buckets.setdefault(minute, []).append(value)
    return [
        {"minuteUtc": minute, "p95Ms": _percentile(values, 95), "n": len(values)}
        for minute, values in sorted(buckets.items())
    ]


def _datapoints_in_window(metric, window):
    points = (metric or {}).get("datapoints") or []
    if window is None:
        return points
    start, end = window
    kept = []
    for point in points:
        stamp = _parse_time(point.get("timestamp"))
        if stamp is not None and start <= stamp < end:
            kept.append(point)
    return kept


def generator_cpu_mean(collect, window):
    metrics = ((collect.get("cloudwatch") or {}).get("metrics") or {})
    points = _datapoints_in_window(metrics.get("generator_cpu"), window)
    values = [point["average"] for point in points if isinstance(point.get("average"), (int, float))]
    if not values:
        return None
    return sum(values) / len(values)


def cloudwatch_partial(collect, window):
    """Descriptive. A partial CloudWatch collect does not drop the k6 p95."""
    window_meta = (collect.get("cloudwatch") or {}).get("window") or {}
    reasons = []
    if window_meta.get("source") != "persisted-run":
        reasons.append("cloudwatch.window.source != persisted-run")
    metrics = ((collect.get("cloudwatch") or {}).get("metrics") or {})
    labels = ["generator_cpu", "rds_cpu", "rds_connections", "alb_target_response_time"]
    for label in list(metrics):
        if label.startswith("app_cpu_"):
            labels.append(label)
    expected = STEADY_MINUTES
    for label in labels:
        if label not in metrics:
            reasons.append(f"{label} missing")
            continue
        count = len(_datapoints_in_window(metrics.get(label), window))
        if expected - count > CW_MISSING_MINUTES:
            reasons.append(f"{label} missing {expected - count} steady minutes")
    return reasons


def parse_apply(campaign_id):
    match = APPLY_RE.match(campaign_id or "")
    if not match:
        return None
    return {
        "count": match.group(1),
        "servers": int(match.group(1)[0]),
        "rep": match.group(2),
        "suffix": match.group(3) or "",
        "replacement": bool(match.group(3)),
    }


def parse_scenario(scenario):
    match = P95_KEY_RE.match(scenario or "")
    if not match:
        return None
    return int(match.group(1)[0]), int(match.group(2))


def rung_sha(collect, manifest_sha):
    explicit = collect.get("measurementSha")
    topo = ((collect.get("terraformOutputs") or {}).get("topology_declaration") or {})
    if not explicit:
        explicit = topo.get("app_source_git_ref")
    return explicit or None, manifest_sha


def evaluate_rung(collect, manifest_sha=None):
    """§7.7 checks for one collect. Scored p95 stays the summary aggregate."""
    scenario = collect.get("scenario")
    errors = []
    if REUSED_KEY_RE.match(scenario or ""):
        errors.append({"code": "REUSED_KEY", "message": f"{scenario} is a fit, holdout, or scale key"})
    parsed = parse_scenario(scenario)
    if parsed is None and not errors:
        errors.append({"code": "REJECTED_KEY", "message": f"{scenario} is not a typical-p95 rung key"})
    servers, rps = parsed if parsed else (None, None)
    campaign_id = collect.get("campaignId") or ""
    apply = parse_apply(campaign_id)
    if parsed and apply is None:
        errors.append({"code": "TEST_ID_MISMATCH", "message": f"campaign id {campaign_id} is not a typical-p95 test id"})
    if parsed and apply and (apply["servers"] != servers):
        errors.append({"code": "TEST_ID_MISMATCH", "message": "test id server count does not match the rung key"})

    latency = collect.get("latency") or {}
    p95 = latency.get("p95Ms")
    untagged = latency.get("untaggedAggregate")
    explicit_sha, fallback_sha = rung_sha(collect, manifest_sha)
    sha = explicit_sha or fallback_sha
    if manifest_sha and explicit_sha and explicit_sha != manifest_sha:
        errors.append({"code": "SHA_MISMATCH", "message": f"sha {explicit_sha} != measurement_sha {manifest_sha}"})
    if manifest_sha and not explicit_sha:
        errors.append({"code": "SHA_MISMATCH", "message": "collect has no measurement sha"})

    artifacts = collect.get("artifacts") or {}
    identity = collect.get("identityMatches")
    if identity is None:
        identity = artifacts.get("identityMatches")
    topo = (collect.get("terraformOutputs") or {}).get("topology_declaration") or {}
    app_ids = (collect.get("terraformOutputs") or {}).get("app_instance_ids") or []
    if parsed and identity is False:
        errors.append({"code": "IDENTITY_MISMATCH", "message": "identityMatches is false"})
    if parsed and (topo.get("app_count") != servers or len(app_ids) != servers):
        errors.append({
            "code": "APP_COUNT_MISMATCH",
            "message": f"app_count {topo.get('app_count')} ids {len(app_ids)} != {servers}",
        })
    if p95 is None:
        errors.append({"code": "P95_MISSING", "message": "latency.p95Ms is null"})
    if parsed and untagged is not True:
        errors.append({
            "code": "DEFINITION_VIOLATION",
            "message": "latency.p95Ms is not the untagged whole-run aggregate",
        })

    k6 = artifacts.get("k6") or {}
    dropped = k6.get("droppedIterations")
    if dropped is None:
        dropped = 0
    peak = k6.get("peakVus")
    window = steady_window(collect)
    cpu = generator_cpu_mean(collect, window)
    generator_invalid = False
    generator_reason = None
    if parsed:
        limit = DROPPED_FRACTION * scheduled_iterations(rps)
        if cpu is None:
            under_budget = peak is not None and peak < preallocated_vus(rps)
            if not (dropped <= limit and under_budget):
                generator_invalid = True
                generator_reason = "generator CPU unavailable and dropped iterations or peak VUs fail the fallback"
        elif cpu > GEN_CPU_MAX or dropped > limit:
            generator_invalid = True
            generator_reason = f"generator CPU {cpu} or dropped iterations {dropped} over the limit {limit}"

    raw = artifacts.get("requestLevelRaw") or {}
    per_minute_present = bool(raw.get("present"))
    partial = cloudwatch_partial(collect, window) if parsed else []
    fatal_codes = {
        "REUSED_KEY",
        "REJECTED_KEY",
        "TEST_ID_MISMATCH",
        "SHA_MISMATCH",
        "IDENTITY_MISMATCH",
        "APP_COUNT_MISMATCH",
        "P95_MISSING",
        "DEFINITION_VIOLATION",
    }
    apply_invalid = any(item["code"] in fatal_codes for item in errors)
    valid = parsed is not None and not apply_invalid and not generator_invalid and p95 is not None
    return {
        "scenario": scenario,
        "campaignId": campaign_id,
        "servers": servers,
        "rps": rps,
        "cell": cell_id(servers, rps) if parsed else None,
        "rep": apply["rep"] if apply else None,
        "suffix": apply["suffix"] if apply else "",
        "replacement": bool(apply and apply["replacement"]),
        "sha": sha,
        "p95Ms": p95,
        "untaggedAggregate": untagged,
        "valid": valid,
        "generatorInvalid": generator_invalid,
        "generatorReason": generator_reason,
        "applyInvalid": apply_invalid,
        "errors": errors,
        "cloudwatchPartial": partial,
        "perMinutePresent": per_minute_present,
        "generatorCpuMean": cpu,
        "droppedIterations": dropped,
        "peakVus": peak,
        "countsForScore": valid,
    }


def _pick_slot(rows):
    """One rep slot keeps the latest letter suffix. Original and replacement are not pooled."""
    valid = [row for row in rows if row["countsForScore"]]
    if not valid:
        return None
    valid.sort(key=lambda row: row["suffix"])
    return valid[-1]


def score_sha_group(rows, model, engine):
    by_cell = {cell: [] for cell in CELLS}
    for row in rows:
        if row["cell"] and (row["servers"], row["rps"]) in by_cell:
            by_cell[(row["servers"], row["rps"])].append(row)
    cells = {}
    scored_medians = {}
    page_scores = {}
    engine_scores = {}
    for cell in CELLS:
        slots = {}
        for row in by_cell[cell]:
            slots.setdefault(row["rep"], []).append(row)
        chosen = []
        for rep in ("1", "2", "3"):
            pick = _pick_slot(slots.get(rep, []))
            if pick is not None:
                chosen.append(pick)
        median = statistics.median(item["p95Ms"] for item in chosen) if len(chosen) == 3 else None
        central = model[cell]
        low, high = acceptance_bounds(central)
        candidate = page_score(median, central) if median is not None else None
        engine_central = None if engine is None else engine["cells"].get(cell)
        engine_score = page_score(median, engine_central) if median is not None else None
        cells[cell_id(*cell)] = {
            "centralMs": central,
            "toleranceMs": [low, high],
            "engineCentralMs": engine_central,
            "reps": [
                {"campaignId": item["campaignId"], "p95Ms": item["p95Ms"], "suffix": item["suffix"]}
                for item in chosen
            ],
            "nValid": len(chosen),
            "medianMs": median,
            "inTolerance": in_tolerance(median, central) if median is not None else None,
            "pageScore": candidate,
            "enginePageScore": engine_score,
            "scored": len(chosen) == 3,
        }
        if len(chosen) == 3:
            scored_medians[cell] = median
            page_scores[cell] = candidate
            engine_scores[cell] = engine_score
    complete = all(cells[cell_id(*cell)]["scored"] for cell in CELLS)
    absolute = None
    server = None
    if complete:
        inside = [cell for cell in CELLS if cells[cell_id(*cell)]["inTolerance"]]
        a_a = len(inside) >= CELLS_IN_TOL_MIN and all(cells[cell_id(n, 300)]["inTolerance"] for n in (1, 2, 3))
        a_b = statistics.median(page_scores[cell] for cell in CELLS) >= PAGE_MIN
        a_c = (
            engine is not None
            and all(engine_scores[(n, 300)] is not None for n in (1, 2, 3))
            and all(page_scores[(n, 300)] > engine_scores[(n, 300)] for n in (1, 2, 3))
        )
        absolute = {
            "A_a": a_a,
            "A_b": a_b,
            "A_c": a_c,
            "pass": bool(a_a and a_b and a_c),
            "cellsInTolerance": len(inside),
            "medianPageScore": statistics.median(page_scores[cell] for cell in CELLS),
        }
        transitions = {}
        for rps in (300, 200, 100):
            for left in (1, 2):
                predicted = model[(left, rps)] / model[(left + 1, rps)]
                measured = scored_medians[(left, rps)] / scored_medians[(left + 1, rps)]
                size_ok = abs(math.log(measured / predicted)) <= math.log(SERVER_TOL[rps])
                direction_required = predicted >= DIRECTION_MIN_RATIO
                direction_ok = (not direction_required) or measured > 1
                transitions[f"{left}->{left + 1}@{rps}"] = {
                    "predictedRatio": predicted,
                    "measuredRatio": measured,
                    "tolerance": SERVER_TOL[rps],
                    "sizeOk": size_ok,
                    "directionRequired": direction_required,
                    "directionOk": direction_ok,
                    "pass": bool(size_ok and direction_ok),
                }
        s300 = transitions["1->2@300"]["pass"] and transitions["2->3@300"]["pass"]
        other_keys = [f"{left}->{left + 1}@{rps}" for rps in (200, 100) for left in (1, 2)]
        other_passes = sum(1 for key in other_keys if transitions[key]["pass"])
        s_other = other_passes >= 3
        server = {
            "S_300": s300,
            "S_other": s_other,
            "otherPasses": other_passes,
            "pass": bool(s300 and s_other),
            "transitions": transitions,
        }
    return {
        "cells": cells,
        "complete": complete,
        "verdictsIssued": complete,
        "absolute": absolute,
        "serverChange": server,
    }


def budget_status(rows, manifest):
    manifest = manifest or {}
    replacement_ids = sorted({row["campaignId"] for row in rows if row["replacement"]})
    spend = manifest.get("spendUsd")
    next_usd = manifest.get("nextApplyUsd") or 0
    next_planned = bool(manifest.get("nextApplyPlanned"))
    would_need_seventh = bool(manifest.get("replacementWouldBeNeeded")) or len(replacement_ids) > REPLACEMENT_BUDGET
    spend_breach = False
    if isinstance(spend, (int, float)):
        spend_breach = spend > SPEND_CAP_USD or (next_planned and spend + next_usd > SPEND_CAP_USD)
    kevin_stopped = bool(manifest.get("kevinStopped"))
    if would_need_seventh or spend_breach:
        status = "PARTIAL: budget exhausted" if kevin_stopped else "pause"
    else:
        status = "ok"
    return {
        "replacementApplies": replacement_ids,
        "replacementCount": len(replacement_ids),
        "replacementBudget": REPLACEMENT_BUDGET,
        "spendUsd": spend,
        "spendCapUsd": SPEND_CAP_USD,
        "status": status,
        "pause": status != "ok",
    }


def pause_reasons(rows, budget):
    reasons = []
    if budget["pause"]:
        reasons.append(budget["status"])
    definition = [row["campaignId"] for row in rows if any(item["code"] == "DEFINITION_VIOLATION" for item in row["errors"])]
    if definition:
        reasons.append("definition violation: scored p95 is not the untagged aggregate")
    missing_raw_applies = {row["campaignId"] for row in rows if row["cell"] and not row["perMinutePresent"]}
    if len(missing_raw_applies) >= 2:
        reasons.append("k6 per-minute output missing in 2 or more applies")
    return reasons


def attach_samples(row, collect, sample_path):
    if not sample_path or not Path(sample_path).is_file():
        row["steadyOnlyP95Ms"] = None
        row["perMinuteP95"] = []
        return row
    samples = read_request_samples(sample_path)
    window = steady_window(collect)
    row["steadyOnlyP95Ms"] = steady_only_p95(samples, window)
    row["perMinuteP95"] = per_minute_p95(samples, window)
    row["perMinutePresent"] = row["perMinutePresent"] or bool(row["perMinuteP95"])
    return row


def score_evidence(collects, model, engine, manifest=None, sample_paths=None):
    """Score one evidence set. `collects` is a list of (collect_dict, optional_sample_path)."""
    manifest = manifest or {}
    manifest_sha = manifest.get("measurementSha")
    rows = []
    rejected = []
    for collect, sample_path in collects:
        row = evaluate_rung(collect, manifest_sha)
        attach_samples(row, collect, sample_path)
        if any(item["code"] == "REUSED_KEY" for item in row["errors"]):
            rejected.append(row)
        rows.append(row)
    if rejected:
        return {
            "ok": False,
            "error": "REUSED_KEY",
            "message": "fit, holdout, or scale keys cannot be scored as typical-p95-v1",
            "rejected": [
                {"scenario": row["scenario"], "campaignId": row["campaignId"], "errors": row["errors"]}
                for row in rejected
            ],
            "verdictsIssued": False,
            "queriedLive": False,
        }
    groups = {}
    for row in rows:
        if row["sha"] is None:
            continue
        groups.setdefault(row["sha"], []).append(row)
    # Never concatenate reps that belong to different SHAs.
    scored = {sha: score_sha_group(group_rows, model, engine) for sha, group_rows in groups.items()}
    budget = budget_status(rows, manifest)
    reasons = pause_reasons(rows, budget)
    return {
        "ok": True,
        "queriedLive": False,
        "candidateSource": "model-predictions.csv",
        "engineSource": None if engine is None else engine.get("engineVersion"),
        "engineFrozen": engine is not None,
        "measurementSha": manifest_sha,
        "groups": {sha: scored[sha] for sha in scored},
        "pooledAcrossShas": False,
        "rungs": rows,
        "budget": budget,
        "pauseReasons": reasons,
        "campaignStatus": budget["status"] if budget["pause"] or reasons else "ok",
    }


def load_evidence_dir(path):
    root = Path(path)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    collects = []
    for collect_path in sorted(root.glob("**/11-*.collect.json")):
        payload = json.loads(collect_path.read_text())
        sample = None
        for candidate in (
            collect_path.with_suffix("").with_name(collect_path.name.replace("11-", "k6-").replace(".collect", "") + ".json.gz"),
            collect_path.parent / "k6.json.gz",
            collect_path.parent / f"k6-{payload.get('scenario')}.json.gz",
        ):
            if candidate.is_file():
                sample = candidate
                break
        collects.append((payload, sample))
    return collects, manifest


def _engine_reference():
    """§5.3 1.2.14 column, for the synthetic dry run only. Not a live query."""
    return {
        "engineVersion": "dry-run-not-a-freeze",
        "calibrationId": None,
        "cells": {
            "1x-300": {"latencyP95": 18.1},
            "1x-200": {"latencyP95": 14.6},
            "1x-100": {"latencyP95": 11.0},
            "2x-300": {"latencyP95": 12.78},
            "2x-200": {"latencyP95": 11.01},
            "2x-100": {"latencyP95": 9.23},
            "3x-300": {"latencyP95": 11.01},
            "3x-200": {"latencyP95": 9.83},
            "3x-100": {"latencyP95": 8.64},
        },
    }


def synthetic_collect(servers, rps, rep, p95, sha, cpu=20.0, dropped=0, peak=10, untagged=True, raw=True):
    count = f"{servers}x"
    campaign = f"typical-p95-{count}-r{rep}-20261012"
    start = datetime(2026, 10, 12, 0, 0, tzinfo=timezone.utc)
    steady_start = start + timedelta(seconds=WARMUP_S)
    points = []
    for minute in range(STEADY_MINUTES):
        stamp = (steady_start + timedelta(minutes=minute)).strftime("%Y-%m-%dT%H:%M:%SZ")
        points.append({"timestamp": stamp, "average": cpu, "maximum": cpu})
    return {
        "ok": True,
        "scenario": f"typical-p95-{count}-{rps}",
        "campaignId": campaign,
        "adapterVersion": "1.6.0",
        "measurementSha": sha,
        "identityMatches": True,
        "latency": {
            "p95Ms": p95,
            "p50Ms": 8.0,
            "p99Ms": p95,
            "source": "k6",
            "untaggedAggregate": untagged,
            "steadySubmetricPresent": not untagged,
        },
        "artifacts": {
            "identityMatches": True,
            "k6": {"droppedIterations": dropped, "peakVus": peak, "present": True},
            "requestLevelRaw": {"present": raw, "files": ["k6.json.gz"] if raw else []},
        },
        "terraformOutputs": {
            "topology_declaration": {"app_count": servers, "app_source_git_ref": sha},
            "app_instance_ids": [f"i-{servers}-{index}" for index in range(servers)],
        },
        "cloudwatch": {
            "window": {
                "source": "persisted-run",
                "actualStartTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "actualEndTime": (start + timedelta(seconds=WARMUP_S + STEADY_S)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            "metrics": {
                "generator_cpu": {"datapoints": points},
                "rds_cpu": {"datapoints": points},
                "rds_connections": {"datapoints": points},
                "alb_target_response_time": {"datapoints": points},
                "app_cpu_i": {"datapoints": points},
            },
        },
    }


def write_synthetic_samples(path, p95):
    start = datetime(2026, 10, 12, 0, 5, tzinfo=timezone.utc)
    lines = []
    for index in range(20):
        stamp = (start + timedelta(seconds=index * 30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        # A few warmup-window points must not move the steady percentile.
        lines.append(json.dumps({
            "type": "Point",
            "metric": "http_req_duration",
            "data": {"time": stamp, "value": p95},
        }))
    warmup = (start - timedelta(minutes=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines.append(json.dumps({
        "type": "Point",
        "metric": "http_req_duration",
        "data": {"time": warmup, "value": p95 * 5},
    }))
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def dry_run(predictions_path, out_path):
    model = load_model_predictions(predictions_path)
    engine_payload = _engine_reference()
    with tempfile.TemporaryDirectory(prefix="p95-v1-dry-run-") as tmp:
        engine_path = Path(tmp) / "engine.json"
        engine_path.write_text(json.dumps(engine_payload))
        engine = load_engine_predictions(engine_path)
        sha = "dry-run-sha"
        collects = []
        for servers, rps in CELLS:
            for rep in ("1", "2", "3"):
                collect = synthetic_collect(servers, rps, rep, model[(servers, rps)], sha)
                sample = Path(tmp) / f"k6-typical-p95-{servers}x-{rps}-r{rep}.json.gz"
                write_synthetic_samples(sample, model[(servers, rps)])
                collects.append((collect, sample))
        result = score_evidence(
            collects,
            model,
            engine,
            {"measurementSha": sha, "spendUsd": 13.0, "nextApplyPlanned": False},
        )
    result["dryRun"] = True
    result["note"] = "Synthetic local fixture. The engine numbers are the §5.3 reference column, not an MCP freeze."
    if out_path:
        Path(out_path).write_text(json.dumps(result, indent=2, default=str) + "\n")
    return result


def main(argv):
    parser = argparse.ArgumentParser(description="Score typical-p95-v1 from local files")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--evidence")
    parser.add_argument("--predictions", default=str(HERE / "predictions" / "model-predictions.csv"))
    parser.add_argument("--engine", default=str(HERE / "predictions" / "engine-baseline" / "predictions.json"))
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    if args.dry_run:
        result = dry_run(args.predictions, args.out)
    else:
        if not args.evidence:
            parser.error("--evidence is required unless --dry-run is set")
        model = load_model_predictions(args.predictions)
        engine = load_engine_predictions(args.engine)
        collects, manifest = load_evidence_dir(args.evidence)
        result = score_evidence(collects, model, engine, manifest)
        if args.out:
            Path(args.out).write_text(json.dumps(result, indent=2, default=str) + "\n")
    summary = {
        "ok": result.get("ok"),
        "dryRun": result.get("dryRun", False),
        "queriedLive": result.get("queriedLive"),
        "campaignStatus": result.get("campaignStatus"),
        "error": result.get("error"),
    }
    if result.get("ok") and result.get("groups"):
        sha = result.get("measurementSha")
        group = result["groups"].get(sha) or next(iter(result["groups"].values()))
        summary["verdictsIssued"] = group["verdictsIssued"]
        summary["absolute"] = None if not group["absolute"] else group["absolute"]["pass"]
        summary["serverChange"] = None if not group["serverChange"] else group["serverChange"]["pass"]
    json.dump(summary, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
