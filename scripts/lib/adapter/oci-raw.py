#!/usr/bin/env python3
"""OCI raw evidence. No cloud access. Bounds are generator-recorded UTC times.

Each request contributes once via http_req_duration, once via http_reqs, and
once via http_req_failed. Never add these three streams together. Drops are
iterations which issued no request, and enter only the loss denominator.
"""
import datetime as dt
import gzip
import hashlib
import json
import math
import sys
from pathlib import Path


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def empty(start, end):
    return dict(start=start, end=end, durations=[], completions=0, hardErrors=0,
                hardSamples=0, classes=dict(success=0, httpNon2xx=0, timeout=0,
                connectionReset=0, connectionRefused=0, transportOther=0,
                droppedIterations=0), httpStatuses={})


def add(window, row):
    data, metric = row["data"], row["metric"]
    value, tags = data["value"], data.get("tags", {})
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid raw metric value")
    if metric == "http_reqs":
        window["completions"] += value
    elif metric == "http_req_failed":
        if value not in (0, 1):
            raise ValueError("invalid hard-error sample")
        window["hardSamples"] += 1
        window["hardErrors"] += value
    elif metric == "dropped_iterations":
        window["classes"]["droppedIterations"] += value
    elif metric == "http_req_duration":
        window["durations"].append(value)
        status = str(tags.get("status", "0"))
        code = str(tags.get("error_code", ""))
        # status=0 or any transport code can never count as a success.
        if status == "0" or (code and 0 < int(code) < 1400):
            kind = {"1050": "timeout", "1220": "connectionReset",
                    "1212": "connectionRefused"}.get(code, "transportOther")
        elif status.isdigit() and 200 <= int(status) <= 299:
            kind = "success"
        else:
            kind = "httpNon2xx"
        window["classes"][kind] += 1
        window["httpStatuses"][status] = window["httpStatuses"].get(status, 0) + 1


def finish(window):
    durations = sorted(window.pop("durations"))
    count = len(durations)
    if count == 0 or count != window["completions"] or count != window["hardSamples"]:
        raise ValueError("raw request streams absent, truncated or inconsistent")
    if window["hardErrors"] > count:
        raise ValueError("invalid hard-error stream")
    drops = window["classes"]["droppedIterations"]
    denominator = count + drops
    losses = denominator - window["classes"]["success"]
    return dict(**window, rawSamples=count, denominator=denominator,
                lossCount=losses, totalLossPct=100 * losses / denominator,
                hardErrorDenominator=count,
                hardErrorPct=100 * window["hardErrors"] / count,
                throughputRps=count / (window["end"] - window["start"]),
                p50Ms=durations[math.ceil(count * .50) - 1],
                p95Ms=durations[math.ceil(count * .95) - 1],
                p99Ms=durations[math.ceil(count * .99) - 1])


def collect(raw, marker):
    start, end = timestamp(marker["startedAt"]), timestamp(marker["endedAt"])
    if end < start + 1200 or marker["exitCode"] != 0:
        raise ValueError("generator failed or incomplete run window")
    windows = dict(steady=empty(start + 300, start + 1200), whole=empty(start, end))
    opener = gzip.open if str(raw).endswith(".gz") else open
    with opener(raw, "rt") as source:
        for line in source:
            row = json.loads(line)
            if row.get("type") != "Point" or row.get("metric") not in (
                    "http_req_duration", "http_reqs", "http_req_failed", "dropped_iterations"):
                continue
            tags = row["data"].get("tags", {})
            for key, expected in (("campaign_id", marker["campaignId"]),
                                  ("run_id", marker["runId"])):
                if tags.get(key) != expected:
                    raise ValueError("raw identity mismatch")
            t = timestamp(row["data"]["time"])
            for name, window in windows.items():
                # Warmup iterations may finish during its 30s graceful stop,
                # after steady has begun. They are never steady observations.
                if (name != "steady" or tags.get("phase") == "steady") and window["start"] <= t < window["end"]:
                    add(window, row)
    digest = hashlib.sha256()
    with open(raw, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    results = {key: finish(window) for key, window in windows.items()}
    summary_bytes = (Path(raw).parent / "summary.json").read_bytes()
    summary = json.loads(summary_bytes)
    def metric(name):
        item = summary["metrics"].get(name, {})
        return item.get("values", item)
    completed = metric("http_reqs").get("count")
    drops = metric("dropped_iterations").get("count", 0)
    if completed != results["whole"]["completions"] or drops != results["whole"]["classes"]["droppedIterations"]:
        raise ValueError("raw evidence disagrees with independent k6 summary counts")
    return dict(identity=marker, rawSha256=digest.hexdigest(),
                rawBytes=Path(raw).stat().st_size, summaryCountVerified=True,
                summarySha256=hashlib.sha256(summary_bytes).hexdigest(),
                method="nearest-rank raw durations; steady phase and UTC bounds; completions/900",
                **results)


if __name__ == "__main__":
    try:
        print(json.dumps(collect(sys.argv[1], json.loads(Path(sys.argv[2]).read_text()))))
    except Exception:
        # Paths, raw tags and arbitrary sample bytes must not reach public logs.
        print('OCI_RAW_EVIDENCE_INVALID', file=sys.stderr)
        sys.exit(1)
