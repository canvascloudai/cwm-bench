#!/usr/bin/env python3
"""typical-dbsat-v1 collect-time steady P95, run on a load generator.

Reads k6 --out json (k6.json.gz) for one run and prints one JSON object:
  exact nearest-rank steady P95 (phase=steady http_req_duration points),
  a sparse log-bucket histogram (ratio 1.001, ~0.1% resolution) so two
  generators can be merged, and per-minute P95 / request / failure counts
  for breach-rule audit. Descriptive only; the scorer recomputes from raw.
Usage: steady_p95.py <run dir>
"""
import gzip
import json
import math
import os
import sys
from datetime import datetime

RATIO = 1.001
LOG_RATIO = math.log(RATIO)


def nearest_rank(values, pct):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(pct / 100.0 * len(ordered))) - 1]


def bucket(value):
    return int(math.floor(math.log(max(value, 1e-3)) / LOG_RATIO))


ERROR_CLASSES = (
    "db_timeout",
    "too_many_connections",
    "queue_full",
    "cpu_overload",
    "internal",
    "unclassified",
)


def parse_time(value):
    text = str(value or "")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def main(run_dir):
    path = os.path.join(run_dir, "k6.json.gz")
    opener = gzip.open
    if not os.path.exists(path):
        path = os.path.join(run_dir, "k6.json")
        opener = open
    if not os.path.exists(path):
        print(json.dumps({"present": False}))
        return
    durations = []
    hist = {}
    minutes = {}
    dropped = 0.0
    failed_count = 0
    saw_error_metric = False
    error_counts = {}
    first_ts = None
    last_ts = None
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"Point"' not in line:
                continue
            is_duration = '"http_req_duration"' in line
            is_failed = '"http_req_failed"' in line
            is_dropped = '"dropped_iterations"' in line
            is_errors = '"errors_by_class"' in line
            if not (is_duration or is_failed or is_dropped or is_errors):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            data = obj.get("data") or {}
            tags = data.get("tags") or {}
            if obj.get("metric") == "dropped_iterations":
                dropped += float(data.get("value", 0))
                continue
            if tags.get("phase") != "steady":
                continue
            stamp = parse_time(data.get("time"))
            if stamp is not None:
                first_ts = stamp if first_ts is None else min(first_ts, stamp)
                last_ts = stamp if last_ts is None else max(last_ts, stamp)
            if obj.get("metric") == "errors_by_class":
                saw_error_metric = True
                klass = tags.get("error_class") or "unclassified"
                if klass not in ERROR_CLASSES:
                    klass = "unclassified"
                error_counts[klass] = error_counts.get(klass, 0) + float(data.get("value", 0))
                continue
            minute = str(data.get("time", ""))[:16]
            row = minutes.setdefault(minute, {"values": [], "requests": 0, "failed": 0})
            value = float(data.get("value", 0))
            if obj.get("metric") == "http_req_duration":
                durations.append(value)
                row["values"].append(value)
                key = bucket(value)
                hist[key] = hist.get(key, 0) + 1
            elif obj.get("metric") == "http_req_failed":
                row["requests"] += 1
                row["failed"] += 1 if value else 0
                failed_count += 1 if value else 0
    per_minute = [
        {
            "minuteUtc": minute,
            "n": len(row["values"]),
            "p95Ms": nearest_rank(row["values"], 95),
            "requests": row["requests"],
            "failed": row["failed"],
            "errorRate": (row["failed"] / row["requests"]) if row["requests"] else None,
        }
        for minute, row in sorted(minutes.items())
    ]
    span = (last_ts - first_ts) if first_ts is not None and last_ts is not None else None
    request_count = len(durations)
    if saw_error_metric:
        error_classes = {key: int(error_counts.get(key, 0)) for key in ERROR_CLASSES}
    elif request_count and failed_count == 0:
        error_classes = {key: 0 for key in ERROR_CLASSES}
    elif failed_count:
        error_classes = {key: None for key in ERROR_CLASSES}
        error_classes["unclassified"] = failed_count
    else:
        error_classes = None
    throughput = (request_count / span) if span else None
    goodput = ((request_count - failed_count) / span) if span else None
    print(json.dumps({
        "present": True,
        "source": os.path.basename(path),
        "n": len(durations),
        "steadyP50Ms": nearest_rank(durations, 50),
        "steadyP95Ms": nearest_rank(durations, 95),
        "steadyP99Ms": nearest_rank(durations, 99),
        "requestCount": request_count,
        "failedCount": failed_count,
        "steadyThroughputRps": throughput,
        "steadyGoodputRps": goodput,
        "errorClasses": error_classes,
        "droppedIterations": dropped,
        "method": "nearest-rank, phase=steady, all http_req_duration points",
        "logHistogram": {"ratio": RATIO, "buckets": {str(k): v for k, v in sorted(hist.items())}},
        "perMinute": per_minute,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1])
