#!/usr/bin/env python3
"""OCI raw evidence. No cloud access. Bounds are generator-recorded UTC times.

Each request contributes once via http_req_duration, once via http_reqs, and
once via http_req_failed. Never add these three streams together. Drops are
iterations which issued no request, and enter only the loss denominator.
"""
import calendar
import datetime as dt
import gzip
import hashlib
import json
import math
import re
import sys
from pathlib import Path


NS = 1_000_000_000
RFC3339 = re.compile(
    r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)"
    r"(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)"
)


class InvalidEvidence(ValueError):
    def __init__(self, reason):
        self.reason = reason


def timestamp(value, reason):
    """Use integer nanoseconds; OL8 Python 3.6 lacks fromisoformat."""
    match = RFC3339.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise InvalidEvidence(reason)
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        moment = dt.datetime(*map(int, (year, month, day, hour, minute, second)))
        offset = 0
        if zone != "Z":
            hours, mins = map(int, zone[1:].split(":"))
            if hours >= 24 or mins >= 60:
                raise ValueError()
            offset = (hours * 60 + mins) * 60 * (-1 if zone[0] == "-" else 1)
        return (calendar.timegm(moment.timetuple()) - offset) * NS + int((fraction or "").ljust(9, "0"))
    except ValueError:
        raise InvalidEvidence(reason)


def empty(start, end):
    return dict(start=start, end=end, durations=[], completions=0, hardErrors=0,
                hardSamples=0, classes=dict(success=0, httpNon2xx=0, timeout=0,
                connectionReset=0, connectionRefused=0, transportOther=0,
                droppedIterations=0), httpStatuses={})


def add(window, row):
    data, metric = row["data"], row["metric"]
    value, tags = data["value"], data.get("tags", {})
    if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise InvalidEvidence("RAW_METRIC_VALUE")
    if metric == "http_reqs":
        window["completions"] += value
    elif metric == "http_req_failed":
        if value not in (0, 1):
            raise InvalidEvidence("RAW_HARD_ERROR_VALUE")
        window["hardSamples"] += 1
        window["hardErrors"] += value
    elif metric == "dropped_iterations":
        window["classes"]["droppedIterations"] += value
    elif metric == "http_req_duration":
        window["durations"].append(value)
        status = str(tags.get("status", "0"))
        code = str(tags.get("error_code", ""))
        # status=0 or any transport code can never count as a success.
        if code and not code.isdigit():
            raise InvalidEvidence("RAW_ERROR_CODE")
        if status == "0" or (code and 0 < int(code) < 1400):
            kind = {"1050": "timeout", "1220": "connectionReset",
                    "1212": "connectionRefused"}.get(code, "transportOther")
        elif status.isdigit() and 200 <= int(status) <= 299:
            kind = "success"
        else:
            kind = "httpNon2xx"
        window["classes"][kind] += 1
        window["httpStatuses"][status] = window["httpStatuses"].get(status, 0) + 1


def finish(window, name):
    durations = sorted(window.pop("durations"))
    count = len(durations)
    if count == 0:
        raise InvalidEvidence(name + "_DURATIONS_MISSING")
    if count != window["completions"]:
        raise InvalidEvidence(name + "_HTTP_REQS_MISMATCH")
    if count != window["hardSamples"]:
        raise InvalidEvidence(name + "_HTTP_REQ_FAILED_MISMATCH")
    if window["hardErrors"] > count:
        raise InvalidEvidence(name + "_HARD_ERROR_COUNT")
    drops = window["classes"]["droppedIterations"]
    denominator = count + drops
    losses = denominator - window["classes"]["success"]
    seconds = (window["end"] - window["start"]) / NS
    window["start"] /= NS
    window["end"] /= NS
    return dict(**window, rawSamples=count, denominator=denominator,
                lossCount=losses, totalLossPct=100 * losses / denominator,
                hardErrorDenominator=count,
                hardErrorPct=100 * window["hardErrors"] / count,
                throughputRps=count / seconds,
                p50Ms=durations[math.ceil(count * .50) - 1],
                p95Ms=durations[math.ceil(count * .95) - 1],
                p99Ms=durations[math.ceil(count * .99) - 1])


def samples(raw, marker, windows):
    opener = gzip.open if str(raw).endswith(".gz") else open
    with opener(raw, "rt") as source:
        for line in source:
            try:
                row = json.loads(line)
            except ValueError:
                raise InvalidEvidence("RAW_JSON")
            if not isinstance(row, dict):
                raise InvalidEvidence("RAW_ROW_SHAPE")
            if row.get("type") != "Point" or row.get("metric") not in (
                    "http_req_duration", "http_reqs", "http_req_failed", "dropped_iterations"):
                continue
            data = row.get("data")
            if not isinstance(data, dict) or not isinstance(data.get("tags"), dict):
                raise InvalidEvidence("RAW_POINT_SHAPE")
            tags = data["tags"]
            for key, expected, reason in (
                ("campaign_id", marker["campaignId"], "RAW_CAMPAIGN_ID"),
                ("run_id", marker["runId"], "RAW_RUN_ID"),
            ):
                if tags.get(key) != expected:
                    raise InvalidEvidence(reason)
            t = timestamp(data.get("time"), "RAW_TIMESTAMP")
            for name, window in windows.items():
                # Warmup iterations may finish during its 30s graceful stop,
                # after steady has begun. They are never steady observations.
                if (name != "steady" or tags.get("phase") == "steady") and window["start"] <= t < window["end"]:
                    if "value" not in data:
                        raise InvalidEvidence("RAW_METRIC_VALUE")
                    add(window, row)


def collect(raw, marker):
    if not isinstance(marker, dict) or not all(isinstance(marker.get(x), str) and marker[x]
                                               for x in ("campaignId", "runId")):
        raise InvalidEvidence("MARKER_IDENTITY")
    start = timestamp(marker.get("startedAt"), "MARKER_STARTED_AT")
    end = timestamp(marker.get("endedAt"), "MARKER_ENDED_AT")
    if marker.get("exitCode") != 0:
        raise InvalidEvidence("MARKER_EXIT_CODE")
    if end < start + 1200 * NS:
        raise InvalidEvidence("MARKER_WINDOW")
    windows = dict(steady=empty(start + 300 * NS, start + 1200 * NS), whole=empty(start, end))
    try:
        samples(raw, marker, windows)
    except (OSError, EOFError, UnicodeError):
        raise InvalidEvidence("RAW_READ")
    digest = hashlib.sha256()
    with open(raw, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    results = {key: finish(window, key.upper()) for key, window in windows.items()}
    try:
        summary_bytes = (Path(raw).parent / "summary.json").read_bytes()
    except OSError:
        raise InvalidEvidence("SUMMARY_READ")
    try:
        summary = json.loads(summary_bytes)
    except (ValueError, UnicodeError):
        raise InvalidEvidence("SUMMARY_JSON")
    if not isinstance(summary, dict) or not isinstance(summary.get("metrics"), dict):
        raise InvalidEvidence("SUMMARY_METRICS")

    def count(name, reason, default=None):
        if name not in summary["metrics"]:
            if default is not None:
                return default
            raise InvalidEvidence(reason)
        item = summary["metrics"][name]
        values = item.get("values", item) if isinstance(item, dict) else None
        value = values.get("count") if isinstance(values, dict) else None
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or value % 1:
            raise InvalidEvidence(reason)
        return value
    completed = count("http_reqs", "SUMMARY_HTTP_REQS_COUNT")
    drops = count("dropped_iterations", "SUMMARY_DROPPED_ITERATIONS_COUNT", 0)
    if completed != results["whole"]["completions"]:
        raise InvalidEvidence("SUMMARY_HTTP_REQS_MISMATCH")
    if drops != results["whole"]["classes"]["droppedIterations"]:
        raise InvalidEvidence("SUMMARY_DROPPED_ITERATIONS_MISMATCH")
    return dict(identity=marker, rawSha256=digest.hexdigest(),
                rawBytes=Path(raw).stat().st_size, summaryCountVerified=True,
                summarySha256=hashlib.sha256(summary_bytes).hexdigest(),
                method="nearest-rank raw durations; steady phase and UTC bounds; completions/900",
                **results)


if __name__ == "__main__":
    try:
        try:
            marker = json.loads(Path(sys.argv[2]).read_text())
        except (ValueError, OSError, IndexError):
            raise InvalidEvidence("MARKER_READ")
        print(json.dumps(collect(sys.argv[1], marker)))
    except Exception as error:
        # Paths, raw tags and arbitrary sample bytes must not reach public logs.
        reason = error.reason if isinstance(error, InvalidEvidence) else "UNCLASSIFIED"
        print("OCI_RAW_EVIDENCE_INVALID:" + reason, file=sys.stderr)
        sys.exit(1)
