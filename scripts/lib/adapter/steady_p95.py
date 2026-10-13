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

RATIO = 1.001
LOG_RATIO = math.log(RATIO)


def nearest_rank(values, pct):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(1, math.ceil(pct / 100.0 * len(ordered))) - 1]


def bucket(value):
    return int(math.floor(math.log(max(value, 1e-3)) / LOG_RATIO))


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
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"Point"' not in line:
                continue
            is_duration = '"http_req_duration"' in line
            is_failed = '"http_req_failed"' in line
            is_dropped = '"dropped_iterations"' in line
            if not (is_duration or is_failed or is_dropped):
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
    print(json.dumps({
        "present": True,
        "source": os.path.basename(path),
        "n": len(durations),
        "steadyP95Ms": nearest_rank(durations, 95),
        "droppedIterations": dropped,
        "method": "nearest-rank, phase=steady, all http_req_duration points",
        "logHistogram": {"ratio": RATIO, "buckets": {str(k): v for k, v in sorted(hist.items())}},
        "perMinute": per_minute,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1])
