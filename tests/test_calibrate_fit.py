"""Per-metric OLS fitter: fit-only rungs, no composite, no public Burst cell."""

from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

import yaml

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
COEFFICIENTS = ROOT / "calibrate" / "coefficients.yaml"
FIT_INPUT = ROOT / "calibrate" / "fit_input.yaml"
EXAMPLE_RUN = ROOT / "schema" / "example-run.json"

_spec = importlib.util.spec_from_file_location(
    "cwm_calibrate_fit", ROOT / "calibrate" / "calibrate.py"
)
_calibrate = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_calibrate)


class CalibrateFitTests(unittest.TestCase):
    def test_default_reproduces_committed_coefficients(self) -> None:
        self.assertEqual(_calibrate.main([]), 0)

    def test_ols_goodput_near_warmup_window(self) -> None:
        observations = _calibrate.load_fit_input(FIT_INPUT)
        metrics = _calibrate.fit_metrics(observations)
        self.assertEqual(len(observations), 3)
        self.assertEqual(
            [obs["scenario"] for obs in observations],
            ["idle", "normal", "peak"],
        )
        self.assertAlmostEqual(metrics["goodput"]["slope"], 0.875, places=3)
        self.assertLess(metrics["goodput"]["residual_sum_squares"], 1e-6)
        self.assertEqual(metrics["error_by_class"]["intercept"], 0.0)
        self.assertEqual(metrics["error_by_class"]["slope"], 0.0)

    def test_holdout_not_in_fit_input(self) -> None:
        payload = yaml.safe_load(FIT_INPUT.read_text())
        scenarios = [rung["scenario"] for rung in payload["rungs"]]
        self.assertEqual(scenarios, ["idle", "normal", "peak"])
        for forbidden in _calibrate.HOLDOUT_FIT_FORBIDDEN:
            self.assertNotIn(forbidden, scenarios)

    def test_burst_in_fit_input_refused(self) -> None:
        payload = yaml.safe_load(FIT_INPUT.read_text())
        payload["rungs"].append(
            {
                "run_id": "473f1339-f712-4096-96d6-3d4fc07cb427:burst",
                "split": "fit",
                "scenario": "burst",
                "target_rps": 1000,
                "measured": {
                    "goodput": 905,
                    "p50": 1.0,
                    "p95": 2.0,
                    "p99": 3.0,
                    "error_rate": 0.0955,
                    "app_cpu_avg": 1.0,
                    "db_cpu": 1.0,
                    "db_conn_max": 1,
                },
            }
        )
        handle = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
        yaml.safe_dump(payload, handle)
        handle.close()
        path = Path(handle.name)
        try:
            with self.assertRaises(_calibrate.HonestyError) as raised:
                _calibrate.load_fit_input(path)
            self.assertEqual(raised.exception.code, 2)
        finally:
            path.unlink()

    def test_refuse_composite_score_flag(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(_calibrate.main(["--composite-score"]), 2)
        self.assertIn(
            "refusing to compute or optimize a composite accuracy score",
            stderr.getvalue(),
        )

    def test_example_run_json_is_ignored(self) -> None:
        stdout = io.StringIO()
        from contextlib import redirect_stdout

        with redirect_stdout(stdout):
            status = _calibrate.main(["--runs", str(EXAMPLE_RUN)])
        self.assertEqual(status, 0)
        self.assertIn("no measurements yet", stdout.getvalue())

    def test_predictions_exist_only_because_metrics_fitted(self) -> None:
        payload = yaml.safe_load(COEFFICIENTS.read_text())
        self.assertTrue(
            all(payload["metrics"][name] is not None for name in _calibrate.METRIC_NAMES)
        )
        self.assertTrue(_calibrate.all_holdout_predictions(payload["holdout_deltas"]))
        payload["metrics"] = {name: None for name in _calibrate.METRIC_NAMES}
        handle = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
        yaml.safe_dump(payload, handle)
        handle.close()
        path = Path(handle.name)
        try:
            self.assertEqual(_calibrate.check_provenance(path), 1)
        finally:
            path.unlink()

    def test_committed_file_has_no_public_burst_cell(self) -> None:
        text = COEFFICIENTS.read_text()
        self.assertNotIn("9.55", text)
        self.assertNotIn("0.0955", text)
        payload = yaml.safe_load(text)
        pred = payload["holdout_deltas"]["burst"]["fit_prediction"]["error_rate"]
        self.assertEqual(pred, 0.0)


if __name__ == "__main__":
    unittest.main()
