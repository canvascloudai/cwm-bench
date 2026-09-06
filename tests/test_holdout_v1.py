"""Owned v1 campaign: filled report, per-metric OLS, no invented public Burst cell."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "holdout" / "REPORT.md"
COEFFICIENTS = ROOT / "calibrate" / "coefficients.yaml"
SUMMARY = ROOT / "holdout" / "exports" / "473f1339.summary.md"

CAMPAIGN_ID = "473f1339-f712-4096-96d6-3d4fc07cb427"
MEASUREMENT_SHA = "7416cb63ace3a7ab2e3486bb6f132a2dcb574c34"
FIT_RUN_IDS = [
    f"{CAMPAIGN_ID}:idle",
    f"{CAMPAIGN_ID}:normal",
    f"{CAMPAIGN_ID}:peak",
]
HOLDOUT_KEYS = (
    "burst",
    "pool-bound",
    "app-bound",
    "cpu-only",
    "later-day",
    "second-region",
)
METRIC_NAMES = (
    "cpu",
    "p50",
    "p95",
    "p99",
    "goodput",
    "error_by_class",
    "connections",
)
MEASURED_FIELDS = (
    "goodput",
    "p50",
    "p95",
    "p99",
    "error_rate",
    "app_cpu_avg",
    "db_cpu",
    "db_conn_max",
)


def _owned_955_ok(line: str) -> bool:
    lowered = line.lower()
    markers = (
        "not copied",
        "not owned",
        "not a company-owned",
        "public",
        "does not match",
        "literature",
        "not the public",
        "do not import",
        "do not copy",
    )
    return any(marker in lowered for marker in markers)


class HoldoutV1Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = REPORT.read_text()
        cls.summary = SUMMARY.read_text()
        cls.coefficients = yaml.safe_load(COEFFICIENTS.read_text())

    def test_report_status_filled(self) -> None:
        self.assertIn("v1 owned campaign present", self.report)
        self.assertIn("Per-metric OLS fitted", self.report)
        self.assertNotIn("**Status: awaiting v1 campaign.**", self.report)
        self.assertNotIn("Coefficients not yet fitted", self.report)
        self.assertNotIn("null (unfitted)", self.report)
        self.assertNotRegex(self.report, r"^\| awaiting v1 campaign \|", re.M)
        self.assertIn(CAMPAIGN_ID, self.report)
        self.assertIn("us-east-2", self.report)
        self.assertIn("us-west-2", self.report)
        self.assertIn("875.1162528375527", self.report)
        self.assertIn("176.92973011451465", self.report)
        self.assertIn("cpu-error term", self.report.lower())

    def test_report_has_holdout_run_ids(self) -> None:
        for key in HOLDOUT_KEYS:
            self.assertIn(f"{CAMPAIGN_ID}:{key}", self.report)
        for run_id in FIT_RUN_IDS:
            self.assertIn(run_id, self.report)

    def test_metrics_are_fitted(self) -> None:
        metrics = self.coefficients["metrics"]
        for name in METRIC_NAMES:
            self.assertIsNotNone(metrics[name], name)
            self.assertEqual(metrics[name]["form"], "affine_in_target_rps")
        self.assertIn("intercept", metrics["cpu"]["app"])
        self.assertIn("intercept", metrics["cpu"]["db"])
        for name in ("p50", "p95", "p99", "goodput", "error_by_class", "connections"):
            self.assertIsInstance(metrics[name]["intercept"], (int, float))
            self.assertIsInstance(metrics[name]["slope"], (int, float))
            self.assertEqual(metrics[name]["n_fit"], 3)
        self.assertEqual(metrics["error_by_class"]["intercept"], 0.0)
        self.assertEqual(metrics["error_by_class"]["slope"], 0.0)
        self.assertAlmostEqual(metrics["goodput"]["slope"], 0.875, places=3)

    def test_measurement_sha_and_created_at(self) -> None:
        self.assertEqual(self.coefficients["measurement_sha"], MEASUREMENT_SHA)
        self.assertEqual(self.coefficients["created_at"], "2026-09-06T03:44:51.130Z")

    def test_burst_not_in_fit_split(self) -> None:
        run_ids = self.coefficients["fit_split"]["run_ids"]
        self.assertEqual(run_ids, FIT_RUN_IDS)
        for run_id in run_ids:
            scenario = run_id.rsplit(":", 1)[-1]
            self.assertNotIn(scenario, HOLDOUT_KEYS)

    def test_holdout_deltas_have_predictions_because_fitted(self) -> None:
        deltas = self.coefficients["holdout_deltas"]
        metrics_fitted = all(
            self.coefficients["metrics"][name] is not None for name in METRIC_NAMES
        )
        self.assertTrue(metrics_fitted)
        for key in HOLDOUT_KEYS:
            self.assertIn(key, deltas)
            entry = deltas[key]
            self.assertIsInstance(entry["measured"], dict)
            self.assertGreaterEqual(len(entry["measured"]), 1)
            self.assertIsInstance(entry["fit_prediction"], dict)
            self.assertIsInstance(entry["delta"], dict)
            for field in MEASURED_FIELDS:
                self.assertIn(field, entry["fit_prediction"], f"{key}.{field}")
                self.assertIn(field, entry["delta"], f"{key}.{field}")
        self.assertEqual(
            deltas["burst"]["measured"]["goodput"],
            875.1162528375527,
        )
        self.assertEqual(
            deltas["burst"]["measured"]["error_rate"],
            9.522521716110773e-07,
        )
        self.assertEqual(deltas["burst"]["fit_prediction"]["error_rate"], 0.0)
        self.assertNotAlmostEqual(
            deltas["burst"]["fit_prediction"]["error_rate"],
            0.0955,
        )
        self.assertNotAlmostEqual(
            deltas["burst"]["fit_prediction"]["goodput"],
            905,
            places=0,
        )

    def test_no_owned_955(self) -> None:
        coeff_text = COEFFICIENTS.read_text()
        self.assertNotIn("9.55", coeff_text)
        self.assertNotIn("0.0955", coeff_text)
        for path, text in (
            (REPORT, self.report),
            (SUMMARY, self.summary),
        ):
            for line_no, line in enumerate(text.splitlines(), 1):
                if "9.55" not in line:
                    continue
                self.assertTrue(
                    _owned_955_ok(line),
                    f"{path}:{line_no} mentions 9.55 without marking it public/not owned: {line}",
                )


if __name__ == "__main__":
    unittest.main()
