"""Schema accepts the lean mix and a typical route-share map."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


class TypicalSchemaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / "schema" / "run.schema.json").read_text())

    def test_scenario_enum_includes_typical_keys(self):
        allowed = self.schema["properties"]["scenario"]["enum"]
        for key in (
            "typical-fit-20",
            "typical-fit-100",
            "typical-fit-200",
            "typical-holdout-300",
            "typical-saturation-500",
            "typical-later-day",
            "typical-later-day-300",
            "typical-second-region",
            "typical-second-region-300",
            "typical-scale-1x-100",
            "typical-scale-1x-200",
            "typical-scale-1x-300",
            "typical-scale-2x-100",
            "typical-scale-2x-200",
            "typical-scale-2x-300",
            "typical-scale-3x-100",
            "typical-scale-3x-200",
            "typical-scale-3x-300",
            "typical-p95-1x-300",
            "typical-p95-1x-200",
            "typical-p95-1x-100",
            "typical-p95-2x-300",
            "typical-p95-2x-200",
            "typical-p95-2x-100",
            "typical-p95-3x-300",
            "typical-p95-3x-200",
            "typical-p95-3x-100",
        ):
            self.assertIn(key, allowed)
        for key in ("idle", "normal", "peak", "burst", "later-day", "second-region"):
            self.assertIn(key, allowed)

    def test_lean_request_mix_and_typical_route_shares(self):
        validator = Draft202012Validator(self.schema["properties"]["requestMix"])
        validator.validate(
            {
                "getProductPct": 70,
                "listPct": 20,
                "writePct": 10,
                "notes": "lean",
            }
        )
        validator.validate(
            {
                "GET /api/articles": 59,
                "GET /api/articles/:slug": 20,
                "GET /api/profiles/:username": 10,
                "POST /api/articles/:slug/comments": 10,
                "POST /api/users/login": 1,
            }
        )
        errors = list(validator.iter_errors({}))
        self.assertTrue(errors)
        errors = list(validator.iter_errors({"GET /api/articles": "59"}))
        self.assertTrue(errors)

    def test_application_profile_and_workers(self):
        validator = Draft202012Validator(self.schema["properties"]["application"])
        validator.validate({"name": "cwm-bench-app", "poolSize": 250, "profile": "typical", "workers": 2})
        validator.validate({"name": "cwm-bench-app", "poolSize": 250, "profile": "lean", "workers": 1})
        errors = list(
            validator.iter_errors({"name": "cwm-bench-app", "poolSize": 250, "profile": "other", "workers": 2})
        )
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
