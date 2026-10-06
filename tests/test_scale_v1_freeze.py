"""typical-scale-v1 freeze matches the committed engine 1.2.14 package.

Scoring reads typical/scale-v1/predictions/predictions.json. This test does
not call an engine, and it does not rewrite typical/scores-after-fit.json.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRED = ROOT / "typical" / "scale-v1" / "predictions" / "predictions.json"
AFTER = ROOT / "typical" / "scores-after-fit.json"
PAYLOADS = ROOT / "typical" / "scale-v1" / "predictions"
AFTER_FIT = ROOT / "typical" / "after-fit"

CELLS = (
    "1x-100",
    "1x-200",
    "1x-300",
    "2x-100",
    "2x-200",
    "2x-300",
    "3x-100",
    "3x-200",
    "3x-300",
)


def _round_to_published(value, published):
    text = format(published, "f").rstrip("0")
    if "." not in text:
        places = 0
    else:
        places = len(text.split(".", 1)[1])
    return round(value, places)


class ScaleV1FreezeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.freeze = json.loads(PRED.read_text())
        cls.after = json.loads(AFTER.read_text())

    def test_package_identity(self):
        self.assertEqual(self.freeze["engineVersion"], "1.2.14")
        self.assertEqual(self.freeze["freezeTimestamp"], "2026-10-06 12:41:17 EDT")
        self.assertEqual(
            self.freeze["calibrationId"],
            "aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0",
        )
        self.assertEqual(list(self.freeze["cells"]), list(CELLS))
        self.assertTrue(self.freeze["allMatchVs4870"])
        self.assertTrue(self.freeze["allMatch2xVsCallLogScored"])
        self.assertEqual(self.freeze["costBreakdown2x300"], 0.879919)

    def test_kinds_errors_and_extrapolation(self):
        for name, cell in self.freeze["cells"].items():
            nodes = int(name[0])
            self.assertEqual(cell["engineVersion"], "1.2.14")
            self.assertEqual(cell["nodes"], nodes)
            self.assertEqual(cell["errorRate"], 0)
            self.assertEqual(cell["currentStep"], 6)
            kind = cell["calibrationEvidence"]["kind"]
            if nodes == 2:
                self.assertEqual(kind, "owned")
                self.assertTrue(cell["effectiveConfigHash"])
                self.assertEqual(cell.get("warnings") or [], [])
                self.assertEqual(cell.get("extrapolationNotes") or [], [])
            else:
                self.assertEqual(kind, "owned-scaled")
                self.assertIsNone(cell["effectiveConfigHash"])
                self.assertGreaterEqual(len(cell["warnings"]), 1)
                self.assertTrue(any("Pool-capacity" in warning for warning in cell["warnings"]))
        self.assertTrue(self.freeze["cells"]["1x-200"]["extrapolationNotes"])
        self.assertTrue(self.freeze["cells"]["1x-300"]["extrapolationNotes"])
        self.assertEqual(self.freeze["cells"]["1x-100"]["extrapolationNotes"], [])

    def test_2x_scored_fields_match_after_fit_without_rewriting_it(self):
        published_text = AFTER.read_text()
        for rps in ("100", "200", "300"):
            cell = self.freeze["cells"][f"2x-{rps}"]
            pred = self.after[rps]["pred"]
            self.assertEqual(cell["appCpuPerHost"], pred["cpu"])
            self.assertEqual(cell["latencyP50"], pred["p50"])
            self.assertEqual(cell["latencyP95"], pred["p95"])
            self.assertEqual(cell["throughput"], pred["thr"])
            self.assertEqual(cell["errorRate"], pred["err"])
            self.assertEqual(cell["dbCpu"], pred["db"])
            self.assertEqual(cell["costPerHour"], pred["cost"])
            self.assertEqual(_round_to_published(cell["latencyP99"], pred["p99"]), pred["p99"])
        self.assertEqual(AFTER.read_text(), published_text)
        self.assertEqual(self.after["300_pageCostBasis"]["total"], 84.2)

    def test_create_payloads_follow_the_2x_graph(self):
        for rps in (100, 200, 300):
            published = json.loads((AFTER_FIT / f"create-payload-{rps}.json").read_text())
            for nodes in (1, 2, 3):
                payload = json.loads((PAYLOADS / f"create-payload-{nodes}x-{rps}.json").read_text())
                self.assertEqual(payload["traffic"], rps)
                self.assertEqual(payload["seed"], 20240601)
                self.assertEqual(payload["minInstances"], nodes)
                self.assertEqual(payload["maxInstances"], nodes)
                self.assertEqual(payload["appWeight"], "typical")
                apps = [item for item in payload["resources"] if item["type"] == "compute"]
                self.assertEqual(len(apps), nodes)
                for index, app in enumerate(apps, start=1):
                    self.assertEqual(app["id"], f"app-{index}")
                    self.assertEqual(app["characteristics"]["appDbPoolSize"], 250)
                    self.assertEqual(app["characteristics"]["size"], "m5.large")
                    self.assertEqual(app["location"]["regionKey"], "us-east-2")
                if nodes == 2:
                    left = dict(published)
                    right = dict(payload)
                    left.pop("name")
                    right.pop("name")
                    self.assertEqual(left, right)


if __name__ == "__main__":
    unittest.main()
