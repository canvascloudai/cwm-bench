"""CI provenance checks for fitted coefficients and honesty gates."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import importlib.util

import yaml

ROOT = Path(__file__).resolve().parents[1]
COEFFICIENTS = ROOT / "calibrate" / "coefficients.yaml"

_spec = importlib.util.spec_from_file_location(
    "cwm_calibrate", ROOT / "calibrate" / "calibrate.py"
)
_calibrate = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_calibrate)
check_provenance = _calibrate.check_provenance
holdout_ids_in_fit = _calibrate.holdout_ids_in_fit
refuse_composite = _calibrate.refuse_composite
HonestyError = _calibrate.HonestyError


def _stub(**overrides) -> dict:
    payload = yaml.safe_load(COEFFICIENTS.read_text())
    payload.update(overrides)
    return payload


def _write(payload: dict) -> Path:
    handle = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False)
    yaml.safe_dump(payload, handle)
    handle.close()
    return Path(handle.name)


class CheckProvenanceTests(unittest.TestCase):
    def test_repo_coefficients_pass(self) -> None:
        self.assertEqual(check_provenance(COEFFICIENTS), 0)

    def test_all_null_still_passes(self) -> None:
        payload = {
            "measurement_sha": None,
            "fit_split": None,
            "holdout_deltas": None,
            "created_at": None,
            "metrics": {
                "cpu": None,
                "p50": None,
                "p95": None,
                "p99": None,
                "goodput": None,
                "error_by_class": None,
                "connections": None,
            },
        }
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 0)
        finally:
            path.unlink()

    def test_burst_in_fit_split_fails(self) -> None:
        payload = _stub()
        payload["fit_split"] = {
            "run_ids": [
                "473f1339-f712-4096-96d6-3d4fc07cb427:idle",
                "473f1339-f712-4096-96d6-3d4fc07cb427:burst",
            ]
        }
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_metrics_without_sha_fails(self) -> None:
        payload = _stub(measurement_sha=None)
        payload["metrics"]["cpu"] = {"scale": 1.0}
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_invented_fit_prediction_without_metrics_fails(self) -> None:
        payload = _stub()
        payload["metrics"] = {name: None for name in payload["metrics"]}
        payload["holdout_deltas"]["burst"]["fit_prediction"] = {"goodput": 905}
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_fitted_metrics_without_holdout_prediction_fails(self) -> None:
        payload = _stub()
        payload["holdout_deltas"]["burst"]["fit_prediction"] = None
        payload["holdout_deltas"]["burst"]["delta"] = None
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_incomplete_metrics_fails(self) -> None:
        payload = _stub()
        payload["metrics"]["p99"] = None
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_sha_without_holdout_deltas_fails(self) -> None:
        payload = _stub(holdout_deltas=None)
        path = _write(payload)
        try:
            self.assertEqual(check_provenance(path), 1)
        finally:
            path.unlink()

    def test_holdout_ids_in_fit_helper(self) -> None:
        self.assertEqual(
            holdout_ids_in_fit(
                {"run_ids": ["camp:idle", "camp:pool-bound", "camp:later-day"]}
            ),
            ["camp:pool-bound", "camp:later-day"],
        )

    def test_refuse_composite(self) -> None:
        with self.assertRaises(HonestyError):
            refuse_composite(["--composite-score"])


if __name__ == "__main__":
    unittest.main()
