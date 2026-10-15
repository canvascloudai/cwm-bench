"""Synthetic-case tests for typical/dbsat-v1/score_dbsat_v1.py (every §7.3/§7.4 outcome)."""

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "typical" / "dbsat-v1"))

import score_dbsat_v1 as s  # noqa: E402

LADDER = s.LADDER


def rec(servers, rps, rep, *, p95=20.0, err=0.0, achieved=None, status="complete", db_cpu=30.0,
        aas=0.5, shares=None, conn=200, classes=None, app_cpu=30.0, pool=1.0, gen_cpu=20.0, **extra):
    r = {
        "servers": servers, "rps": rps, "rep": rep, "status": status,
        "overload_minutes": 3 if status == "overload" else None,
        "steady_p95_ms": p95, "error_rate": err,
        "achieved_rps": achieved if achieved is not None else rps * (1 - err),
        "error_rates_by_class": classes or {},
        "app_cpu_by_node": [app_cpu] * servers,
        "db_cpu_mean": db_cpu, "pi_aas_mean": aas,
        "wait_shares": shares if shares is not None else {"cpu": 0.5, "io": 0.2, "lock": 0.1},
        "connections_max": conn, "pool_wait_p95_ms": pool,
        "generator": {"cpu_mean": gen_cpu, "dropped_ratio": 0.0, "network_out_ratio": 0.1},
        "alb_elb_5xx_ratio": 0.0, "target_connection_errors": 0,
    }
    r.update(extra)
    return r


def campaign(n, cell):
    """cell(servers, rps, rep) -> kwargs or None (not tested)."""
    out = []
    for servers in (n, n + 1):
        for rep in (1, 2):
            for rps in LADDER:
                kw = cell(servers, rps, rep)
                if kw is not None:
                    out.append(rec(servers, rps, rep, **kw))
    return out


def outcome(records, n=2):
    return s.transition_outcome(records, n)


PRESSURE = {"db_cpu": 85.0, "aas": 2.4, "shares": {"cpu": 0.7, "io": 0.1, "lock": 0.1}}


def breakpoint_cell(at=1100, prev_gain=2.0, pressure=PRESSURE, extra_n1=None, extra_n=None, lower_ok=True):
    def cell(servers, rps, rep):
        big = servers == 3
        if rps < at:
            gain = prev_gain if lower_ok else 1.1
            return {"p95": 20.0 if big else 20.0 * gain}
        kw = {"p95": 100.0, **pressure}
        kw.update((extra_n1 if big else extra_n) or {})
        return kw
    return cell


class ErrorRatio(unittest.TestCase):
    def test_zero_rules(self):
        self.assertEqual(s.error_ratio(0, 0), (1.0, "1 (both zero)"))
        self.assertEqual(s.error_ratio(0.05, 0)[0], math.inf)
        self.assertEqual(s.error_ratio(0, 0.02), (0.0, "0 (N zero)"))
        self.assertAlmostEqual(s.error_ratio(0.04, 0.01)[0], 4.0)

    def test_infinite_ratio_needs_pp_drop(self):
        small = s.compare_pair(rec(2, 700, 1, err=0.005), rec(3, 700, 1, err=0.0, achieved=700 * 0.995))
        self.assertFalse(small["improves"])
        big = s.compare_pair(rec(2, 700, 1, err=0.03, achieved=700 * 0.99), rec(3, 700, 1, err=0.0, achieved=700 * 0.99))
        self.assertTrue(big["improves"])
        self.assertEqual(big["by"], ["errors"])

    def test_thresholds_are_strict(self):
        at = s.compare_pair(rec(2, 300, 1, p95=29.0), rec(3, 300, 1, p95=20.0))
        self.assertFalse(at["improves"])  # 1.45 is not > 1.45
        self.assertAlmostEqual(at["p95_change_pct"], (20 / 29 - 1) * 100)
        self.assertTrue(s.compare_pair(rec(2, 300, 1, achieved=290), rec(3, 300, 1, achieved=300))["improves"])

    def test_breached_n_with_complete_n1_improves(self):
        pair = s.compare_pair(rec(2, 1300, 1, status="overload"), rec(3, 1300, 1))
        self.assertTrue(pair["improves"])
        self.assertIsNone(s.compare_pair(rec(2, 1300, 1), rec(3, 1300, 1, status="overload")))

    def test_summary_geomean_and_arithmetic_pp(self):
        pairs = [s.compare_pair(rec(2, 300, 1, p95=40, err=0.02), rec(3, 300, 1, p95=20, err=0.0)),
                 s.compare_pair(rec(2, 300, 2, p95=80, err=0.0), rec(3, 300, 2, p95=20, err=0.0))]
        summ = s.summarise_pairs(pairs)
        self.assertAlmostEqual(summ["rp_geomean"], math.sqrt(2 * 4))
        self.assertAlmostEqual(summ["err_pp_mean"], 0.01)
        self.assertEqual(summ["err_ratio_undefined_or_zero"], ["∞ (N+1 zero)"])


class Outcomes(unittest.TestCase):
    def test_candidate_breakpoint(self):
        res = outcome(campaign(2, breakpoint_cell()))
        self.assertEqual(res["outcome"], "candidate DB breakpoint")
        self.assertEqual(res["range"], [900, 1100])
        self.assertIn("cpu", res["pressure_types"])
        self.assertFalse(res["pool_attribution_not_assessable"])

    def test_candidate_lists_between_steps(self):
        def cell(servers, rps, rep):
            if rps <= 500:
                return {"p95": 20.0 if servers == 3 else 40.0}
            if rps < 1100:
                return {"p95": 20.0 if servers == 3 else 22.0}
            return {"p95": 100.0, **PRESSURE}
        res = outcome(campaign(2, cell))
        self.assertEqual(res["range"], [500, 1100])
        self.assertEqual(res["between"], [700, 900])

    def test_pool_waiting_with_db_pressure_does_not_break_headroom(self):
        res = outcome(campaign(2, breakpoint_cell(extra_n1={"pool": 40.0}, extra_n={"pool": 40.0})))
        self.assertEqual(res["outcome"], "candidate DB breakpoint")
        step = next(x for x in res["steps"] if x["rps"] == 1100)
        self.assertEqual(step["per_rep"][0]["headroom_n1"]["pool_attribution"], "pool waiting with DB pressure")

    def test_db_pressure_without_lower_bound(self):
        res = outcome(campaign(2, breakpoint_cell(lower_ok=False)))
        self.assertEqual(res["outcome"], "DB pressure observed at X, no replica-benefit transition located")
        self.assertEqual(res["at"], 1100)

    def test_below_tested_range(self):
        res = outcome(campaign(2, breakpoint_cell(at=300)))
        self.assertEqual(res["outcome"], "below tested range")
        self.assertEqual(res["at"], 300)

    def test_app_bottleneck(self):
        res = outcome(campaign(2, breakpoint_cell(pressure={"db_cpu": 40.0}, extra_n={"app_cpu": 85.0})))
        self.assertEqual(res["outcome"], "app/other bottleneck")
        self.assertEqual(res["at"], 1100)

    def test_app_pool_limit_is_app_bottleneck(self):
        res = outcome(campaign(2, breakpoint_cell(pressure={"db_cpu": 40.0}, extra_n1={"pool": 30.0})))
        self.assertEqual(res["outcome"], "app/other bottleneck")
        step = next(x for x in res["steps"] if x["rps"] == 1100)
        self.assertIn("app pool limit", step["per_rep"][0]["headroom_n1"]["reasons"])

    def test_inconclusive(self):
        def cell(servers, rps, rep):
            if rps < 900:
                return {"p95": 20.0 if servers == 3 else 40.0}
            if rps == 900:
                return {"p95": 20.0 if servers == 3 or rep == 2 else 40.0, **PRESSURE}
            return {"p95": 100.0, **PRESSURE}
        res = outcome(campaign(2, cell))
        step = next(x for x in res["steps"] if x["rps"] == 900)
        self.assertEqual(step["classification"], "inconclusive")
        # 1100 still qualifies, S_prev is 700: the inconclusive 900 is listed between.
        self.assertEqual(res["outcome"], "candidate DB breakpoint")
        self.assertEqual(res["between"], [900])
        only = [r for r in campaign(2, cell) if r["rps"] <= 900]
        self.assertEqual(outcome(only)["outcome"], "inconclusive")
        self.assertEqual(outcome(only)["at"], 900)

    def test_no_breakpoint_every_step_improves(self):
        res = outcome(campaign(2, lambda servers, rps, rep: {"p95": 20.0 if servers == 3 else 40.0}))
        self.assertEqual(res["outcome"], "no DB breakpoint established within tested range")

    def test_no_breakpoint_with_overload_and_not_tested(self):
        def cell(servers, rps, rep):
            if rps <= 1100:
                return {"p95": 20.0 if servers == 3 else 40.0}
            if rps == 1300 and servers == 2:
                return {"status": "overload"}
            if servers == 2:
                return None
            return {"p95": 20.0}
        res = outcome(campaign(2, cell))
        self.assertEqual(res["outcome"], "no DB breakpoint established within tested range")
        self.assertTrue(res["step_labels"]["2x-1300-r1"].startswith("overload observation"))
        self.assertEqual(res["step_labels"]["2x-1500-r1"], "not tested")
        step = next(x for x in res["steps"] if x["rps"] == 1300)
        self.assertEqual(step["classification"], "improves")  # breached N vs complete N+1
        self.assertFalse(step["complete_both"])  # but never S_prev / S*

    def test_unattributed_timeout(self):
        res = outcome(campaign(2, breakpoint_cell(pressure={"db_cpu": 40.0, "classes": {"db_timeout": 0.01}})))
        self.assertEqual(res["outcome"], "unattributed timeout")

    def test_corroborated_timeout_is_pressure(self):
        p = s.db_pressure(rec(3, 900, 1, db_cpu=85.0, classes={"db_timeout": 0.01}))
        self.assertIn("db_timeout (corroborated)", p["types"])
        self.assertFalse(p["unattributed_timeout"])

    def test_mixed_uncertain(self):
        res = outcome(campaign(2, breakpoint_cell(extra_n1={"pool": 40.0, "app_cpu": 65.0})))
        self.assertEqual(res["outcome"], "mixed/uncertain")

    def test_pressure_types(self):
        self.assertEqual(s.db_pressure(rec(3, 900, 1, conn=480))["types"], ["connection-cap"])
        self.assertEqual(s.db_pressure(rec(3, 900, 1, classes={"too_many_connections": 0.002}))["types"], ["connection-cap"])
        io = s.db_pressure(rec(3, 900, 1, aas=1.6, shares={"cpu": 0.3, "io": 0.5, "lock": 0.1}), aas_at_300=0.5)
        self.assertEqual(io["types"], ["io"])
        lock = s.db_pressure(rec(3, 900, 1, aas=2.1, shares={"cpu": 0.3, "io": 0.1, "lock": 0.45}))
        self.assertEqual(lock["types"], ["lock"])
        self.assertFalse(s.db_pressure(rec(3, 900, 1, aas=1.0, shares={"cpu": 0.9}))["pressure"])

    def test_pool_not_assessable_caps_at_candidate(self):
        res = outcome(campaign(2, breakpoint_cell(extra_n1={"pool": None}, extra_n={"pool": None})))
        self.assertEqual(res["outcome"], "candidate DB breakpoint")
        self.assertTrue(res["pool_attribution_not_assessable"])


def conf_records(n, cell, top=1300):
    out = []
    for servers in (n, n + 1):
        for rps in [r for r in LADDER if r <= top]:
            kw = cell(servers, rps)
            if kw is not None:
                out.append(rec(servers, rps, "c", **kw))
    return out


class NoData(unittest.TestCase):
    def test_no_records_is_not_a_verdict(self):
        self.assertEqual(outcome([])["outcome"], "no comparable complete steps (not scored)")


class Confirmation(unittest.TestCase):
    def setUp(self):
        self.candidate = outcome(campaign(2, breakpoint_cell()))

    def good(self, servers, rps):
        if rps < 1100:
            return {"p95": 20.0 if servers == 3 else 40.0}
        return {"p95": 100.0, **PRESSURE}

    def test_confirmed(self):
        res = s.confirmation_outcome(self.candidate, conf_records(2, self.good), 2)
        self.assertEqual(res["result"], "confirmed")

    def test_failed_confirmation_is_valid_negative(self):
        def cell(servers, rps):
            return {"p95": 20.0 if servers == 3 else 40.0}  # S* still improves
        res = s.confirmation_outcome(self.candidate, conf_records(2, cell), 2)
        self.assertEqual(res["result"], "candidate, not confirmed")
        self.assertFalse(res["checks"]["b_s_star_no_improvement"])
        self.assertIn("none", res["retry"])

    def test_different_pressure_type_fails(self):
        def cell(servers, rps):
            if rps < 1100:
                return {"p95": 20.0 if servers == 3 else 40.0}
            return {"p95": 100.0, "conn": 490}
        res = s.confirmation_outcome(self.candidate, conf_records(2, cell), 2)
        self.assertEqual(res["result"], "candidate, not confirmed")
        self.assertFalse(res["checks"]["c_same_pressure_type"])

    def test_not_completed_due_to_overload(self):
        def cell(servers, rps):
            if servers == 2 and rps == 1100:
                return {"status": "overload"}
            if servers == 2 and rps > 1100:
                return None
            return self.good(servers, rps)
        res = s.confirmation_outcome(self.candidate, conf_records(2, cell), 2)
        self.assertEqual(res["result"], "confirmation not completed due to overload")
        self.assertEqual(res["steps_not_complete"], ["2x-1100"])

    def test_invalid_confirmation(self):
        records = conf_records(2, self.good)
        records[0]["invalid"] = "generator-invalid (§7.5)"
        res = s.confirmation_outcome(self.candidate, records, 2)
        self.assertEqual(res["result"], "invalid confirmation")
        self.assertIn("§7.7", res["note"])

    def test_pool_not_assessable_caps(self):
        def cell(servers, rps):
            kw = self.good(servers, rps)
            return {**kw, "pool": None}
        res = s.confirmation_outcome(self.candidate, conf_records(2, cell), 2)
        self.assertTrue(res["result"].startswith("candidate (confirmed criteria met; capped"))

    def test_not_triggered_without_candidate(self):
        none = outcome(campaign(2, lambda servers, rps, rep: {"p95": 20.0 if servers == 3 else 40.0}))
        self.assertEqual(s.confirmation_outcome(none, [], 2)["result"], "not triggered")

    def test_score_runs_both_transitions(self):
        records = campaign(2, breakpoint_cell()) + [r for r in campaign(3, breakpoint_cell()) if r["servers"] == 4]
        out = s.score(records, conf_records(2, self.good))
        self.assertEqual([t["transition"] for t in out["transitions"]], ["2→3", "3→4"])
        self.assertEqual(out["transitions"][0]["confirmation"]["result"], "confirmed")
        self.assertTrue(out["interpretations"])


class Aggregation(unittest.TestCase):
    def test_missing_minute_rule(self):
        self.assertEqual(s.aggregate_minutes({i: 1.0 for i in range(13)}, "mean"), 1.0)
        self.assertIsNone(s.aggregate_minutes({i: 1.0 for i in range(12)}, "mean"))
        self.assertEqual(s.aggregate_minutes({1: 3.0, **{i + 2: 1.0 for i in range(14)}}, "max"), 3.0)

    def test_record_from_collect(self):
        from datetime import datetime, timedelta, timezone
        start = datetime(2026, 10, 13, 1, 0, tzinfo=timezone.utc)
        steady0 = start + timedelta(minutes=5)
        def series(field, value, minutes=15):
            return {"datapoints": [{"timestamp": (steady0 + timedelta(minutes=i)).isoformat(), field: value} for i in range(minutes)]}
        collect = {
            "cloudwatch": {"window": {"actualStartTime": start.isoformat()}, "metrics": {
                "app_cpu_i-a": series("average", 40.0), "app_cpu_i-b": series("average", 50.0),
                "rds_cpu": series("average", 60.0), "rds_connections": series("maximum", 300.0),
                "generator_cpu": series("average", 20.0),
                "alb_request_count": series("sum", 6000.0), "alb_http_elb_5xx": series("sum", 0.0)}},
            "errorCategories": {"db_timeout": 0, "too_many_connections": 9},
            "dbsat": {
                "steadyP95": {"steadyP95Ms": 33.0, "droppedIterations": 0, "perMinute": [{"requests": 6000, "failed": 6}] * 15},
                "performanceInsights": {"available": True, "series": [
                    {"metric": "db.load.avg", "dimensions": None, "datapoints": [{"timestamp": (steady0 + timedelta(minutes=i)).isoformat(), "value": 1.0} for i in range(15)]},
                    {"metric": "db.load.avg", "dimensions": {"db.wait_event_type.name": "CPU"}, "datapoints": [{"timestamp": (steady0 + timedelta(minutes=i)).isoformat(), "value": 0.6} for i in range(15)]}]},
                "poolMetrics": {"available": True, "nodes": [{"minutes": [{"minute": steady0.isoformat(), "waitBucketRatio": 1.001, "waitBuckets": {"0": 95, "2000": 5}}]}]},
                "cloudwatch": {"metrics": {"generator_network_out_i-g": series("sum", 60 * 1.5625e9 / 8 * 0.1)}},
                "partialStep": {"partial": False},
            },
        }
        r = s.record_from_collect(collect, None, servers=2, rps=300, rep=1)
        self.assertEqual(r["status"], "complete")
        self.assertEqual(r["steady_p95_ms"], 33.0)
        self.assertEqual(r["app_cpu_by_node"], [40.0, 50.0])
        self.assertAlmostEqual(r["achieved_rps"], 100.0)
        self.assertAlmostEqual(r["error_rate"], 0.001)
        self.assertAlmostEqual(r["pi_aas_mean"], 1.0)
        self.assertAlmostEqual(r["wait_shares"]["cpu"], 0.6)
        self.assertEqual(r["connections_max"], 300.0)
        self.assertAlmostEqual(r["generator"]["network_out_ratio"], 0.1)
        self.assertEqual(r["alb_elb_5xx_ratio"], 0.0)
        self.assertAlmostEqual(r["pool_wait_p95_ms"], 1.001 ** 1, places=6)


class D1eDerivedFixes(unittest.TestCase):
    """Synthetic fixtures shaped like the 4x dry-run collects (values rounded,
    identifiers synthetic; no raw evidence)."""

    @staticmethod
    def _collect(start, steady_minutes, partial, pi_names, classes, per_minute, cw_minutes):
        from datetime import timedelta
        steady0 = start + timedelta(minutes=5)
        minute0 = steady0.replace(second=0, microsecond=0)
        def series(field, value):
            return {"datapoints": [{"timestamp": (minute0 + timedelta(minutes=i)).isoformat(), field: value} for i in range(cw_minutes)]}
        def pi(value, name=None):
            return {"metric": "db.load.avg", "dimensions": ({"db.wait_event_type.name": name} if name else None),
                    "datapoints": [{"timestamp": (minute0 + timedelta(minutes=i)).isoformat(), "value": value} for i in range(cw_minutes)]}
        return {
            "cloudwatch": {"window": {"actualStartTime": start.isoformat()}, "metrics": {
                "app_cpu_i-app0001": series("average", 20.0), "rds_cpu": series("average", 93.0),
                "rds_connections": series("maximum", 377.0), "generator_cpu": series("average", 13.0),
                "alb_request_count": series("sum", 54000.0), "alb_http_elb_5xx": series("sum", 2.0)}},
            "errorCategories": classes,
            "dbsat": {
                "steadyP95": {"steadyP95Ms": 150.0, "droppedIterations": 0, "perMinute": per_minute},
                "performanceInsights": {"available": True, "series": [
                    pi(12.0), pi(9.6, pi_names[0]), pi(1.8, pi_names[1]), pi(0.0, pi_names[2])]},
                "poolMetrics": {"available": True, "nodes": [{"minutes": [{"minute": minute0.isoformat(), "waitBucketRatio": 1.001, "waitBuckets": {"-6000": 100}}]}]},
                "cloudwatch": {"metrics": {"generator_cpu_i-gen0001": series("average", 13.0),
                                           "generator_network_out_i-gen0001": series("sum", 1.0e7)}},
                "partialStep": {"partial": partial, "steadyMinutesObserved": steady_minutes},
            },
        }

    def test_pi_wait_types_match_case_insensitively(self):
        from datetime import datetime, timezone
        start = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
        rows = [{"requests": 42000, "failed": 0}] * 15
        lower = self._collect(start, 15, False, ("io", "cpu", "lock"), {"internal": 0}, rows, 15)
        upper = self._collect(start, 15, False, ("IO", "CPU", "Lock"), {"internal": 0}, rows, 15)
        a = s.record_from_collect(lower, None, servers=4, rps=700, rep=1)
        b = s.record_from_collect(upper, None, servers=4, rps=700, rep=1)
        self.assertAlmostEqual(a["wait_shares"]["io"], 0.8)
        self.assertAlmostEqual(a["wait_shares"]["cpu"], 0.15)
        self.assertEqual(a["wait_shares"], b["wait_shares"])
        self.assertIn("io", s.db_pressure(a)["types"])

    def test_class_rates_use_steady_denominator(self):
        from datetime import datetime, timezone
        start = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
        rows = [{"requests": 10000, "failed": 900}] * 15
        # whole-step counts larger than steady failures (ramp minutes included)
        c = self._collect(start, 15, False, ("io", "cpu", "lock"), {"internal": 3000, "too_many_connections": 1000, "db_timeout": 0}, rows, 15)
        r = s.record_from_collect(c, None, servers=4, rps=700, rep=1)
        self.assertAlmostEqual(r["error_rate"], 0.09)
        self.assertAlmostEqual(sum(r["error_rates_by_class"].values()), r["error_rate"])
        self.assertAlmostEqual(r["error_rates_by_class"]["internal"], 0.0675)
        self.assertAlmostEqual(r["error_rates_by_class"]["too_many_connections"], 0.0225)
        self.assertEqual(r["error_rates_by_class"]["db_timeout"], 0.0)

    def test_class_rates_without_requests_or_failures(self):
        self.assertEqual(s._steady_class_rates({"internal": 5}, 0, 0), {"internal": None})
        self.assertEqual(s._steady_class_rates({"internal": 0}, 0, 100), {"internal": 0.0})

    def test_partial_step_keeps_breach_minutes(self):
        from datetime import datetime, timezone
        # sub-minute offset like the dry run (actual start hh:mm:01)
        start = datetime(2026, 1, 1, 10, 0, 1, tzinfo=timezone.utc)
        rows = [{"requests": 54000, "failed": 4900}] * 5
        c = self._collect(start, 5, True, ("io", "cpu", "lock"), {"internal": 24500}, rows, 3)
        r = s.record_from_collect(c, None, servers=4, rps=900, rep=1)
        self.assertEqual(r["status"], "overload")
        self.assertEqual(r["db_cpu_mean"], 93.0)
        self.assertEqual(r["connections_max"], 377.0)
        self.assertEqual(r["app_cpu_by_node"], [20.0])
        self.assertIsNotNone(r["generator"]["cpu_mean"])
        p = s.db_pressure(r)
        self.assertIn("cpu", p["types"])
        self.assertIn("io", p["types"])
        self.assertEqual(p["not_assessable"], [])


class PartialAchievedRps(unittest.TestCase):
    def _collect(self, start, stop):
        rows = [{"requests": 54000, "failed": 0}] * 4 + [{"requests": 9000, "failed": 0}]
        return {"cloudwatch": {"window": {"actualStartTime": start.isoformat()}, "metrics": {}},
                "errorCategories": {}, "dbsat": {"steadyP95": {"steadyP95Ms": 100.0, "perMinute": rows},
                "partialStep": {"partial": True, "steadyMinutesObserved": 5, "stop": {"reason": "breach", "at": stop}}}}

    def test_truncated_last_minute_uses_elapsed_seconds(self):
        from datetime import datetime, timedelta, timezone
        start = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)   # steady starts 10:05:00
        c = self._collect(start, "2026-01-01T10:09:10Z")               # 4 min + 10 s
        r = s.record_from_collect(c, None, servers=4, rps=900, rep=1)
        self.assertAlmostEqual(r["achieved_rps_elapsed_s"], 250.0)
        self.assertAlmostEqual(r["achieved_rps"], 225000 / 250.0)
        span = (start + timedelta(minutes=5), start + timedelta(minutes=9, seconds=10))
        r2 = s.record_from_collect(c, None, servers=4, rps=900, rep=1, steady_span=span)
        self.assertEqual(r2["achieved_rps_elapsed_source"], "k6 steady-phase span")
        self.assertAlmostEqual(r2["achieved_rps"], 900.0)

    def test_fallback_without_stop(self):
        from datetime import datetime, timezone
        start = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
        c = self._collect(start, None)
        r = s.record_from_collect(c, None, servers=4, rps=900, rep=1)
        self.assertEqual(r["achieved_rps_elapsed_s"], 300)

    def test_steady_span_from_k6(self):
        import gzip, json as _j, tempfile, os
        rows = [{"metric": "http_reqs", "type": "Point", "data": {"time": t, "value": 1, "tags": {"phase": ph}}}
                for t, ph in (("2026-01-01T10:04:59.5Z", "warmup"), ("2026-01-01T10:05:00.25Z", "steady"),
                              ("2026-01-01T10:09:10.123456789Z", "steady"))]
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "k6.json.gz")
            with gzip.open(f, "wt") as h:
                h.write("\n".join(_j.dumps(r, separators=(",", ":")) for r in rows) + "\n")
            first, last = s.steady_span_from_k6(f)
        self.assertAlmostEqual((last - first).total_seconds(), 249.873456, places=5)


class RequestOutcomeClasses(unittest.TestCase):
    """Synthetic request_outcomes points (no raw evidence)."""

    @staticmethod
    def _write(path, points):
        import gzip, json as _j
        with gzip.open(path, "wt") as h:
            h.write(_j.dumps({"type": "Metric", "metric": "request_outcomes", "data": {"type": "counter"}}) + "\n")
            for phase, status, cls, n in points:
                for _ in range(n):
                    h.write(_j.dumps({"metric": "request_outcomes", "type": "Point", "data": {
                        "time": "2026-01-01T10:05:00Z", "value": 1,
                        "tags": {"phase": phase, "name": "x", "http_status": status, "error_class": cls}}},
                        separators=(",", ":")) + "\n")

    def _collect(self):
        from datetime import datetime, timezone
        start = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
        rows = [{"requests": 100, "failed": 0}] * 14 + [{"requests": 100, "failed": 10}]
        return {"cloudwatch": {"window": {"actualStartTime": start.isoformat()}, "metrics": {}},
                "errorCategories": {"internal": 0, "db_timeout": 0, "unclassified": 10},
                "dbsat": {"steadyP95": {"steadyP95Ms": 50.0, "perMinute": rows}}}

    def test_k6_points_give_app_classes(self):
        import os, tempfile
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "k6.json.gz")
            self._write(f, [("warmup", "500", "internal", 5), ("steady", "200", "none", 180),
                            ("steady", "500", "internal", 16), ("steady", "502", "none", 3),
                            ("steady", "0", "unclassified", 1)])
            ro = s.request_outcomes_from_k6(f)
        self.assertEqual(ro["total"], 200)
        self.assertEqual(ro["classes"], {"internal": 16, "unclassified": 4})
        self.assertEqual(ro["by_status_class"]["502/none"], 3)
        r = s.record_from_collect(self._collect(), None, servers=2, rps=300, rep=1, request_outcomes=ro)
        self.assertEqual(r["error_classes_source"], "k6 request_outcomes (steady)")
        self.assertAlmostEqual(r["error_rates_by_class"]["internal"], 0.08)
        self.assertAlmostEqual(r["error_rates_by_class"]["unclassified"], 0.02)
        self.assertEqual(r["error_rates_by_class"]["db_timeout"], 0.0)

    def test_fallback_to_adapter_categories(self):
        import os, tempfile
        r = s.record_from_collect(self._collect(), None, servers=2, rps=300, rep=1)
        self.assertEqual(r["error_classes_source"], "adapter errorCategories")
        self.assertAlmostEqual(r["error_rates_by_class"]["unclassified"], 10 / 1500)
        self.assertIsNone(r["error_counts_by_status_class"])
        with tempfile.TemporaryDirectory() as d:   # k6 file without request_outcomes points
            f = os.path.join(d, "k6.json.gz")
            self._write(f, [])
            ro = s.request_outcomes_from_k6(f)
        r2 = s.record_from_collect(self._collect(), None, servers=2, rps=300, rep=1, request_outcomes=ro)
        self.assertEqual(r2["error_classes_source"], "adapter errorCategories")


if __name__ == "__main__":
    unittest.main()
