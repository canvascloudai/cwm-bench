#!/usr/bin/env python3
"""Independent §3.1 recomputation from the raw k6 gzips (does not use the runner's breach monitor).

Usage: recompute_breach_minutes.py EVIDENCE_DIR [--out breach-minutes.json]
Per full UTC minute [m, m+60s): steady-phase request_outcomes points (failure = http_status >= 400 or 0)
and nearest-rank P95 over steady http_req_duration points. A minute is eligible only if it lies entirely
inside the steady span (first..last steady http_reqs point) and inside the rung window (end = breach stop);
an ineligible minute breaks the streak. Breach = 3 consecutive eligible minutes with error > 0.05 or P95 > 2000.
"""
import argparse, collections, glob, gzip, json, math
from datetime import datetime, timedelta, timezone
from pathlib import Path
SERVERS = 2
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
def k6time(s):
    """k6 RFC 3339 time with nanoseconds -> aware datetime (truncated to microseconds)."""
    base, frac = s[:19], ""
    rest = s[19:]
    if rest.startswith("."):
        i = 1
        while i < len(rest) and rest[i].isdigit(): i += 1
        frac, rest = rest[1:i][:6].ljust(6, "0"), rest[i:]
    tz = timezone.utc if rest in ("Z", "") else datetime.strptime(rest.replace(":", ""), "%z").tzinfo
    dt = datetime.fromisoformat(base).replace(tzinfo=tz)
    return (dt + timedelta(microseconds=int(frac or 0))).astimezone(timezone.utc)
def scan(path):
    tot, fail, dur = collections.Counter(), collections.Counter(), collections.defaultdict(list)
    first = last = None
    with gzip.open(path, "rt", errors="replace") as h:
        for line in h:
            if '"Point"' not in line or '"phase":"steady"' not in line: continue
            o = json.loads(line); d = o["data"]; t = d.get("tags") or {}
            if t.get("phase") != "steady": continue
            at = k6time(d["time"])
            m = at.replace(second=0, microsecond=0)
            if o["metric"] == "http_reqs":
                first = at if first is None or at < first else first; last = at if last is None or at > last else last
            elif o["metric"] == "http_req_duration": dur[m].append(float(d["value"]))
            elif o["metric"] == "request_outcomes":
                v = float(d["value"]); tot[m] += v
                st = str(t.get("http_status"))
                if st == "0" or (st.isdigit() and int(st) >= 400): fail[m] += v
    return tot, fail, dur, first, last
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("evidence"); ap.add_argument("--out", default="breach-minutes.json")
    a = ap.parse_args(); root = Path(a.evidence)
    ce = json.loads((root / "campaign-execution.json").read_text()); out = {}
    for ap_ in ce["applies"]:
        camp = ap_["campaign"]; rep = camp.split("-r")[1][0]; rungs = []
        for rg in ap_["rungs"]:
            k6 = glob.glob(str(root / "out" / camp / f"rungs/typical-dbsat-{SERVERS}x-{rg['rate']}-*/k6.json.gz"))[0]
            tot, fail, dur, first, last = scan(k6)
            end = ts(rg.get("stoppedAt") or rg["endedAt"])
            rows, streak, breach = [], 0, None
            for m in sorted(set(tot) | set(dur)):
                elig = first is not None and m >= first.replace(microsecond=0) and m + timedelta(seconds=60) <= min(last + timedelta(seconds=1), end)
                d = sorted(dur[m]); p95 = d[max(1, math.ceil(0.95 * len(d))) - 1] if d else None
                er = fail[m] / tot[m] if tot[m] else None
                over = bool(elig and ((er is not None and er > 0.05) or (p95 is not None and p95 > 2000)))
                streak = streak + 1 if over else 0
                if streak >= 3 and breach is None: breach = m.isoformat()
                rows.append({"minuteUtc": m.isoformat(), "eligible": elig, "responses": int(tot[m]), "failures": int(fail[m]),
                             "errorRate": er, "p95Ms": p95, "overLimit": over, "consecutive": streak})
            rungs.append({"rps": rg["rate"], "steady_first_utc": first.isoformat() if first else None,
                          "steady_last_utc": last.isoformat() if last else None, "window_end_utc": end.isoformat(),
                          "eligible_minutes": sum(r["eligible"] for r in rows),
                          "max_eligible_error_rate": max((r["errorRate"] for r in rows if r["eligible"] and r["errorRate"] is not None), default=None),
                          "max_eligible_p95_ms": max((r["p95Ms"] for r in rows if r["eligible"] and r["p95Ms"] is not None), default=None),
                          "breach_third_minute_utc": breach, "minutes": rows})
        out[rep] = {"campaign": camp, "first_breach_rps": next((r["rps"] for r in rungs if r["breach_third_minute_utc"]), None), "rungs": rungs}
    Path(a.out).write_text(json.dumps(out, indent=1) + "\n")
if __name__ == "__main__": main()
