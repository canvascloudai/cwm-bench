"""typical-p95-v1 predictor and scorer. No AWS and no live engine."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "typical" / "p95-v1"))

from score_p95_v1 import (  # noqa: E402
    SCALE_V1_P95_MEDIANS,
    TOL_HIGH,
    TOL_LOW,
    dry_run,
    load_model_predictions,
    page_score,
    scale_v1_p95_medians,
    score_evidence,
    steady_only_p95,
    synthetic_collect,
    write_synthetic_samples,
)


PREDICTIONS = ROOT / "typical/p95-v1/predictions/model-predictions.csv"
PARAMS = ROOT / "typical/p95-v1/predictions/recommended-params.json"
PREDICT = ROOT / "typical/p95-v1/predictions/predict_p95.py"


class PredictorTest(unittest.TestCase):
    def test_predict_p95_reproduces_csv_exactly(self):
        out = subprocess.check_output([sys.executable, str(PREDICT), str(PARAMS)], text=True)
        self.assertEqual(out, PREDICTIONS.read_text())

    def test_scale_v1_medians_match_prereg(self):
        self.assertEqual(scale_v1_p95_medians(ROOT), SCALE_V1_P95_MEDIANS)

    def test_page_score_and_tolerance_examples(self):
        self.assertEqual(round(page_score(41.31, 34.26), 1), 82.9)
        self.assertEqual(TOL_LOW, 0.666)
        self.assertEqual(TOL_HIGH, 1.432)
        self.assertEqual(round(106.48 * TOL_LOW, 2), 70.92)
        self.assertEqual(round(106.48 * TOL_HIGH, 2), 152.48)


class ScorerTest(unittest.TestCase):
    def setUp(self):
        self.model = load_model_predictions(PREDICTIONS)
        self.sha = "measurement-sha"
        self.engine = {
            "engineVersion": "frozen-for-test",
            "calibrationId": "test",
            "cells": {
                (1, 300): 18.1,
                (1, 200): 14.6,
                (1, 100): 11.0,
                (2, 300): 12.78,
                (2, 200): 11.01,
                (2, 100): 9.23,
                (3, 300): 11.01,
                (3, 200): 9.83,
                (3, 100): 8.64,
            },
        }

    def _happy(self, overrides=None):
        overrides = overrides or {}
        collects = []
        for servers, rps in ((n, t) for n in (1, 2, 3) for t in (300, 200, 100)):
            for rep in ("1", "2", "3"):
                value = overrides.get((servers, rps), self.model[(servers, rps)])
                collects.append((synthetic_collect(servers, rps, rep, value, self.sha), None))
        return collects

    def test_dry_run_passes_both_verdicts_without_a_live_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.json"
            result = dry_run(PREDICTIONS, out)
        self.assertTrue(result["ok"])
        self.assertFalse(result["queriedLive"])
        self.assertTrue(result["engineFrozen"])
        group = result["groups"]["dry-run-sha"]
        self.assertTrue(group["verdictsIssued"])
        self.assertTrue(group["absolute"]["pass"])
        self.assertTrue(group["serverChange"]["pass"])
        self.assertEqual(result["campaignStatus"], "ok")
        self.assertTrue(result["pooledAcrossShas"] is False)
        scored = group["cells"]["1x-300"]["medianMs"]
        steady = result["rungs"][0]["steadyOnlyP95Ms"]
        self.assertEqual(scored, self.model[(1, 300)])
        self.assertEqual(steady, self.model[(1, 300)])

    def test_reused_key_is_rejected(self):
        collect = synthetic_collect(1, 300, "1", 95.0, self.sha)
        collect["scenario"] = "typical-scale-1x-300"
        result = score_evidence([(collect, None)], self.model, self.engine, {"measurementSha": self.sha})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "REUSED_KEY")
        self.assertFalse(result["verdictsIssued"])

    def test_shas_are_not_pooled(self):
        collects = self._happy()
        other = synthetic_collect(1, 300, "1", 1000.0, "other-sha")
        other["campaignId"] = "typical-p95-1x-r1-20261013"
        result = score_evidence(
            collects + [(other, None)],
            self.model,
            self.engine,
            {"measurementSha": self.sha},
        )
        self.assertTrue(result["ok"])
        self.assertIn(self.sha, result["groups"])
        self.assertNotEqual(
            result["groups"][self.sha]["cells"]["1x-300"]["medianMs"],
            1000.0,
        )
        self.assertEqual(result["groups"][self.sha]["cells"]["1x-300"]["medianMs"], self.model[(1, 300)])
        self.assertTrue(result["groups"][self.sha]["absolute"]["pass"])

    def test_absolute_can_pass_while_server_change_fails(self):
        overrides = {(1, 300): 80.0, (2, 300): 45.0}
        result = score_evidence(self._happy(overrides), self.model, self.engine, {"measurementSha": self.sha})
        group = result["groups"][self.sha]
        self.assertTrue(group["absolute"]["pass"])
        self.assertFalse(group["serverChange"]["S_300"])
        self.assertFalse(group["serverChange"]["pass"])

    def test_direction_is_not_required_at_100(self):
        overrides = {(1, 100): 8.0, (2, 100): 8.5}
        result = score_evidence(self._happy(overrides), self.model, self.engine, {"measurementSha": self.sha})
        transition = result["groups"][self.sha]["serverChange"]["transitions"]["1->2@100"]
        self.assertLess(transition["measuredRatio"], 1)
        self.assertFalse(transition["directionRequired"])
        self.assertTrue(transition["pass"])

    def test_generator_rules_and_missing_cpu_fallback(self):
        hot = synthetic_collect(1, 300, "1", self.model[(1, 300)], self.sha, cpu=80)
        hot_row = __import__("score_p95_v1", fromlist=["evaluate_rung"]).evaluate_rung(hot, self.sha)
        self.assertTrue(hot_row["generatorInvalid"])
        self.assertFalse(hot_row["valid"])

        missing = synthetic_collect(1, 100, "1", self.model[(1, 100)], self.sha, peak=10)
        missing["cloudwatch"]["metrics"]["generator_cpu"] = {"datapoints": []}
        ok_row = __import__("score_p95_v1", fromlist=["evaluate_rung"]).evaluate_rung(missing, self.sha)
        self.assertFalse(ok_row["generatorInvalid"])
        self.assertTrue(ok_row["valid"])

        over_vu = synthetic_collect(1, 100, "1", self.model[(1, 100)], self.sha, peak=100)
        over_vu["cloudwatch"]["metrics"]["generator_cpu"] = {"datapoints": []}
        bad_row = __import__("score_p95_v1", fromlist=["evaluate_rung"]).evaluate_rung(over_vu, self.sha)
        self.assertTrue(bad_row["generatorInvalid"])

    def test_steady_only_p95_is_not_the_scored_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "k6.json.gz"
            write_synthetic_samples(sample, 50.0)
            collect = synthetic_collect(1, 300, "1", 106.48, self.sha)
            from score_p95_v1 import read_request_samples, steady_window

            samples = read_request_samples(sample)
            steady = steady_only_p95(samples, steady_window(collect))
        self.assertEqual(steady, 50.0)
        self.assertNotEqual(steady, collect["latency"]["p95Ms"])

    def test_definition_violation_pauses_and_budget_accounts_replacements(self):
        broken = synthetic_collect(1, 300, "1", 106.48, self.sha, untagged=False)
        result = score_evidence([(broken, None)], self.model, self.engine, {"measurementSha": self.sha})
        self.assertIn("untagged", " ".join(result["pauseReasons"]))
        self.assertFalse(result["rungs"][0]["valid"])

        replacements = []
        for letter in "abcdefg":
            row = synthetic_collect(1, 100, "1", 9.59, self.sha)
            row["campaignId"] = f"typical-p95-1x-r1{letter}-20261012"
            replacements.append((row, None))
        paused = score_evidence(replacements, self.model, self.engine, {"measurementSha": self.sha, "spendUsd": 10})
        self.assertEqual(paused["budget"]["replacementCount"], 7)
        self.assertEqual(paused["budget"]["status"], "pause")
        stopped = score_evidence(
            replacements,
            self.model,
            self.engine,
            {"measurementSha": self.sha, "spendUsd": 41, "kevinStopped": True},
        )
        self.assertEqual(stopped["budget"]["status"], "PARTIAL: budget exhausted")

    def test_replacement_supersedes_the_original_slot(self):
        original = synthetic_collect(1, 300, "1", 1000.0, self.sha)
        replacement = synthetic_collect(1, 300, "1", self.model[(1, 300)], self.sha)
        replacement["campaignId"] = "typical-p95-1x-r1a-20261012"
        others = []
        for servers, rps in ((n, t) for n in (1, 2, 3) for t in (300, 200, 100)):
            if (servers, rps) == (1, 300):
                continue
            for rep in ("1", "2", "3"):
                others.append((synthetic_collect(servers, rps, rep, self.model[(servers, rps)], self.sha), None))
        for rep in ("2", "3"):
            others.append((synthetic_collect(1, 300, rep, self.model[(1, 300)], self.sha), None))
        result = score_evidence(
            [(original, None), (replacement, None), *others],
            self.model,
            self.engine,
            {"measurementSha": self.sha},
        )
        cell = result["groups"][self.sha]["cells"]["1x-300"]
        self.assertEqual(sorted(item["p95Ms"] for item in cell["reps"]), [self.model[(1, 300)]] * 3)
        self.assertNotIn(1000.0, [item["p95Ms"] for item in cell["reps"]])

    def test_scorer_does_not_reference_a_live_client(self):
        text = (ROOT / "typical/p95-v1/score_p95_v1.py").read_text()
        for token in ("boto3", "urllib", "requests.", "http.client"):
            self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
