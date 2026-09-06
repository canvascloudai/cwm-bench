#!/usr/bin/env python3
"""Per-metric ordinary least-squares calibration for cwm-bench.

Honesty rules (also in README, CONTRIBUTING, and CI):
  1. Never optimize the composite accuracy score.
  2. Fit per-metric only (CPU, P50/P95/P99, goodput, error-by-class,
     connections) on a declared fit split.
  3. Hold out Burst, plus a later day and a second region.
  4. Coefficients ship with measurement SHA, fit split, holdout deltas.
     A coefficients change without a new measurement ID is rejected.
  5. Fit from owned idle/normal/peak measurements already published in
     this repo. Do not invent CloudWatch. Do not copy the public
     2%/9.55% Burst cell as owned data.
  6. gp2 BurstBalance hitting 0 is a THIRD error bucket, distinct from
     CPU failures and DB connection failures.

Loss (computed independently per metric; never summed into a score):

    For each metric M in {cpu, p50, p95, p99, goodput, error_by_class, connections}:
        L(M) = sum_{run in fit_split} (model(M, run) - measured(M, run))^2

    model(M, run) = intercept_M + slope_M * target_rps(run)

    cpu is two independent affines (app_cpu_avg and db_cpu).
    error_by_class is fit on the published fail_rate / error_rate.
    Fit rungs idle/normal/peak all have error_rate 0, so that OLS is
    the zero model. That is a caveat, not a reason to import the
    public 2% Burst literature cell.

    Burst, pool-bound, app-bound, cpu-only, later-day, and
    second-region are holdout. They never enter L(M). After a fit
    they receive fit_prediction and delta = measured - fit_prediction.

This script:
  * Fits from calibrate/fit_input.yaml (owned published fit rungs)
    when --runs is omitted.
  * Optionally reads schema-valid run JSON from --runs
    (isExample:true files are ignored).
  * Refuses to compute or optimize a composite accuracy score
    (exit 2 if asked).
  * Refuses Burst / diagnostics / later-day / second-region in the
    fit split (exit 2).
  * --write updates coefficients.yaml metrics + holdout predictions.
  * Default invocation recomputes the fit and checks that
    coefficients.yaml matches (reproducibility).
  * --check-provenance validates coefficients.yaml against the
    provenance schema, rejects Burst in fit_split, rejects fitted
    metrics without a measurement_sha, and rejects invented
    fit_prediction while metrics.* are null. When metrics are
    fitted, every holdout must carry fit_prediction and delta.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - CI installs PyYAML
    yaml = None


REPO_ROOT = Path(__file__).resolve().parents[1]
CALIBRATE_DIR = Path(__file__).resolve().parent
COEFFICIENTS_PATH = CALIBRATE_DIR / "coefficients.yaml"
COEFFICIENTS_SCHEMA_PATH = CALIBRATE_DIR / "coefficients.schema.yaml"
FIT_INPUT_PATH = CALIBRATE_DIR / "fit_input.yaml"
RUN_SCHEMA_PATH = REPO_ROOT / "schema" / "run.schema.json"

HOLDOUT_FIT_FORBIDDEN = frozenset(
    {
        "burst",
        "pool-bound",
        "app-bound",
        "cpu-only",
        "later-day",
        "second-region",
    }
)

SCENARIO_TARGET_RPS = {
    "idle": 10.0,
    "normal": 100.0,
    "peak": 500.0,
    "burst": 1000.0,
    "pool-bound": 1000.0,
    "app-bound": 1000.0,
    "cpu-only": 1000.0,
    "later-day": 100.0,
    "second-region": 100.0,
}

METRIC_NAMES = (
    "cpu",
    "p50",
    "p95",
    "p99",
    "goodput",
    "error_by_class",
    "connections",
)

# Independent OLS series. cpu is two series under one metric object.
AFFINE_SERIES = (
    ("p50", "p50"),
    ("p95", "p95"),
    ("p99", "p99"),
    ("goodput", "goodput"),
    ("error_by_class", "error_rate"),
    ("connections", "db_conn_max"),
)

AFFINE_FORM = "affine_in_target_rps"
MEASURED_FIELD_NAMES = (
    "goodput",
    "p50",
    "p95",
    "p99",
    "error_rate",
    "app_cpu_avg",
    "db_cpu",
    "db_conn_max",
)

COMPOSITE_FLAGS = (
    "composite",
    "composite-score",
    "optimize-score",
    "accuracy-score",
    "overall-score",
    "score",
)

FLOAT_REL_TOL = 1e-9
FLOAT_ABS_TOL = 1e-12


class HonestyError(SystemExit):
    pass


def refuse_composite(argv: list[str]) -> None:
    joined = " ".join(argv).lower().replace("_", "-")
    for flag in COMPOSITE_FLAGS:
        token = f"--{flag}"
        if token in joined.split() or f"--{flag}=" in joined:
            print(
                "refusing to compute or optimize a composite accuracy score",
                file=sys.stderr,
            )
            raise HonestyError(2)


def load_runs(paths: list[Path]) -> list[dict]:
    runs: list[dict] = []
    schema = json.loads(RUN_SCHEMA_PATH.read_text())
    try:
        import jsonschema
    except ImportError:
        jsonschema = None

    for path in paths:
        data = json.loads(path.read_text())
        if jsonschema is not None:
            jsonschema.validate(data, schema)
        if data.get("isExample") is True:
            continue
        runs.append(data)
    return runs


def run_id_scenario(run_id: str) -> str:
    token = str(run_id).strip()
    if ":" in token:
        token = token.rsplit(":", 1)[-1]
    return token.lower()


def holdout_ids_in_fit(fit_split: object) -> list[str]:
    if not isinstance(fit_split, dict):
        return []
    bad: list[str] = []
    for run_id in fit_split.get("run_ids") or []:
        if run_id_scenario(run_id) in HOLDOUT_FIT_FORBIDDEN:
            bad.append(str(run_id))
    return bad


def any_holdout_prediction(deltas: object) -> bool:
    if not isinstance(deltas, dict):
        return False
    for entry in deltas.values():
        if isinstance(entry, dict) and entry.get("fit_prediction") is not None:
            return True
    return False


def all_holdout_predictions(deltas: object) -> bool:
    if not isinstance(deltas, dict) or not deltas:
        return False
    for entry in deltas.values():
        if not isinstance(entry, dict):
            return False
        if entry.get("fit_prediction") is None or entry.get("delta") is None:
            return False
    return True


def validate_coefficients_schema(payload: dict) -> list[str]:
    if yaml is None:
        return ["PyYAML is required to load coefficients.schema.yaml"]
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        return []
    schema = yaml.safe_load(COEFFICIENTS_SCHEMA_PATH.read_text())
    return [
        f"{e.json_path}: {e.message}"
        for e in Draft202012Validator(schema).iter_errors(payload)
    ]


def check_provenance(path: Path) -> int:
    if yaml is None:
        print("PyYAML is required for --check-provenance", file=sys.stderr)
        return 1
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        print(f"{path}: not a mapping", file=sys.stderr)
        return 1

    schema_errors = validate_coefficients_schema(payload)
    if schema_errors:
        print(f"{path}: coefficients schema failed", file=sys.stderr)
        for err in schema_errors:
            print(f"  {err}", file=sys.stderr)
        return 1

    metrics = payload.get("metrics") or {}
    any_fit = any(metrics.get(name) is not None for name in METRIC_NAMES)
    sha = payload.get("measurement_sha")
    fit_split = payload.get("fit_split")
    holdout_deltas = payload.get("holdout_deltas")
    created_at = payload.get("created_at")
    provenance_started = any(
        value is not None for value in (sha, fit_split, holdout_deltas, created_at)
    )

    if any_fit and not sha:
        print(
            f"{path}: coefficients present without measurement_sha "
            "(a coefficients change without a new measurement ID is rejected)",
            file=sys.stderr,
        )
        return 1
    if (any_fit or provenance_started) and fit_split is None:
        print(f"{path}: coefficients present without fit_split", file=sys.stderr)
        return 1
    if (any_fit or provenance_started) and holdout_deltas is None:
        print(
            f"{path}: coefficients present without holdout_deltas",
            file=sys.stderr,
        )
        return 1
    if provenance_started and not sha:
        print(
            f"{path}: provenance fields set without measurement_sha "
            "(a coefficients change without a new measurement ID is rejected)",
            file=sys.stderr,
        )
        return 1
    if provenance_started and created_at is None:
        print(f"{path}: provenance fields set without created_at", file=sys.stderr)
        return 1

    forbidden = holdout_ids_in_fit(fit_split)
    if forbidden:
        print(
            f"{path}: Burst/holdout run id in fit_split (hold Burst out): "
            + ", ".join(forbidden),
            file=sys.stderr,
        )
        return 1

    if not any_fit and any_holdout_prediction(holdout_deltas):
        print(
            f"{path}: fit_prediction set while metrics.* are null "
            "(measured-only stub; do not invent predictions)",
            file=sys.stderr,
        )
        return 1
    if any_fit:
        missing = [name for name in METRIC_NAMES if metrics.get(name) is None]
        if missing:
            print(
                f"{path}: incomplete per-metric fit (still null): "
                + ", ".join(missing),
                file=sys.stderr,
            )
            return 1
        if not all_holdout_predictions(holdout_deltas):
            print(
                f"{path}: metrics are fitted but a holdout is missing "
                "fit_prediction/delta",
                file=sys.stderr,
            )
            return 1
    return 0


def ols_affine(xs: list[float], ys: list[float]) -> dict[str, float | int | str]:
    """Ordinary least squares for y = intercept + slope * x."""
    if len(xs) != len(ys) or len(xs) < 2:
        raise ValueError("OLS needs at least two paired observations")
    n = len(xs)
    x_mean = sum(xs) / n
    y_mean = sum(ys) / n
    sxx = sum((x - x_mean) ** 2 for x in xs)
    sxy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    if sxx == 0:
        slope = 0.0
        intercept = y_mean
    else:
        slope = sxy / sxx
        intercept = y_mean - slope * x_mean
    rss = sum((intercept + slope * x - y) ** 2 for x, y in zip(xs, ys))
    return {
        "form": AFFINE_FORM,
        "intercept": float(intercept),
        "slope": float(slope),
        "residual_sum_squares": float(rss),
        "n_fit": n,
    }


def predict_affine(coeff: dict, rps: float) -> float:
    return float(coeff["intercept"]) + float(coeff["slope"]) * float(rps)


def _hosts_mean(hosts: object) -> float | None:
    if not isinstance(hosts, list) or not hosts:
        return None
    values = [float(x) for x in hosts]
    return sum(values) / len(values)


def load_fit_input(path: Path) -> list[dict]:
    if yaml is None:
        print("PyYAML is required to load fit_input.yaml", file=sys.stderr)
        raise HonestyError(1)
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        print(f"{path}: not a mapping", file=sys.stderr)
        raise HonestyError(1)
    rungs = payload.get("rungs")
    if not isinstance(rungs, list) or not rungs:
        print(f"{path}: rungs must be a non-empty list", file=sys.stderr)
        raise HonestyError(1)

    observations: list[dict] = []
    for raw in rungs:
        if not isinstance(raw, dict):
            print(f"{path}: rung is not a mapping", file=sys.stderr)
            raise HonestyError(1)
        run_id = str(raw.get("run_id") or "")
        scenario = str(raw.get("scenario") or run_id_scenario(run_id))
        split = raw.get("split")
        if split != "fit" or scenario in HOLDOUT_FIT_FORBIDDEN:
            print(
                f"{path}: holdout/Burst rung in fit input ({run_id or scenario}); "
                "hold Burst out. Refusing to fit.",
                file=sys.stderr,
            )
            raise HonestyError(2)
        measured = dict(raw.get("measured") or {})
        hosts_mean = _hosts_mean(raw.get("app_cpu_hosts"))
        if hosts_mean is not None:
            published = measured.get("app_cpu_avg")
            if published is None:
                measured["app_cpu_avg"] = hosts_mean
            elif not math.isclose(
                float(published), hosts_mean, rel_tol=1e-12, abs_tol=1e-12
            ):
                print(
                    f"{path}: {run_id} app_cpu_avg does not match mean of "
                    "published app_cpu_hosts",
                    file=sys.stderr,
                )
                raise HonestyError(1)
        target = raw.get("target_rps")
        if target is None:
            target = SCENARIO_TARGET_RPS.get(scenario)
        if target is None:
            print(f"{path}: {run_id} missing target_rps", file=sys.stderr)
            raise HonestyError(1)
        observations.append(
            {
                "run_id": run_id,
                "split": "fit",
                "scenario": scenario,
                "target_rps": float(target),
                "measured": measured,
            }
        )
    return observations


def observations_from_runs(runs: list[dict]) -> list[dict]:
    observations: list[dict] = []
    for run in runs:
        if run.get("split") != "fit":
            continue
        scenario = str(run.get("scenario") or run_id_scenario(str(run.get("run_id") or "")))
        diagnostic = run.get("diagnostic")
        if (
            scenario in HOLDOUT_FIT_FORBIDDEN
            or diagnostic in ("pool-bound", "app-bound", "cpu-only")
            or scenario == "burst"
        ):
            print(
                "Burst (or pool-bound burst diagnostic) is in the fit split; "
                "hold Burst out. Refusing to fit.",
                file=sys.stderr,
            )
            raise HonestyError(2)
        target = (run.get("concurrency") or {}).get("targetRps")
        if target is None:
            target = SCENARIO_TARGET_RPS.get(scenario)
        latency = run.get("latency") or {}
        per_node = run.get("perNode") or []
        app_cpus = [
            float(n["cpuAvgPct"])
            for n in per_node
            if n.get("role") == "app" and n.get("cpuAvgPct") is not None
        ]
        db_cpus = [
            float(n["cpuAvgPct"])
            for n in per_node
            if n.get("role") == "database" and n.get("cpuAvgPct") is not None
        ]
        measured = {
            "goodput": run.get("goodputRps"),
            "p50": latency.get("p50Ms"),
            "p95": latency.get("p95Ms"),
            "p99": latency.get("p99Ms"),
            "error_rate": run.get("fail_rate"),
            "app_cpu_avg": (sum(app_cpus) / len(app_cpus)) if app_cpus else None,
            "db_cpu": (sum(db_cpus) / len(db_cpus)) if db_cpus else None,
            "db_conn_max": (run.get("databaseConnections") or {}).get("max"),
        }
        observations.append(
            {
                "run_id": str(run.get("run_id") or ""),
                "split": "fit",
                "scenario": scenario,
                "target_rps": float(target) if target is not None else None,
                "measured": measured,
            }
        )
    return observations


def refuse_holdout_observations(observations: list[dict]) -> None:
    bad = [
        str(obs.get("run_id") or obs.get("scenario"))
        for obs in observations
        if obs.get("split") == "fit"
        and (
            run_id_scenario(str(obs.get("run_id") or "")) in HOLDOUT_FIT_FORBIDDEN
            or obs.get("scenario") in HOLDOUT_FIT_FORBIDDEN
        )
    ]
    if bad:
        print(
            "Burst (or holdout diagnostic) is in the fit split; "
            "hold Burst out. Refusing to fit.",
            file=sys.stderr,
        )
        raise HonestyError(2)


def _series_points(
    observations: list[dict], field: str
) -> tuple[list[float], list[float]]:
    xs: list[float] = []
    ys: list[float] = []
    for obs in observations:
        value = (obs.get("measured") or {}).get(field)
        target = obs.get("target_rps")
        if value is None or target is None:
            print(
                f"fit observation {obs.get('run_id')} missing {field} or target_rps",
                file=sys.stderr,
            )
            raise HonestyError(1)
        xs.append(float(target))
        ys.append(float(value))
    return xs, ys


def fit_metrics(observations: list[dict]) -> dict[str, Any]:
    refuse_holdout_observations(observations)
    fit_obs = [obs for obs in observations if obs.get("split") == "fit"]
    if len(fit_obs) < 2:
        print("need at least two fit-split observations", file=sys.stderr)
        raise HonestyError(1)

    metrics: dict[str, Any] = {}
    for metric_name, field in AFFINE_SERIES:
        xs, ys = _series_points(fit_obs, field)
        coeff = ols_affine(xs, ys)
        coeff["predicts"] = field
        if metric_name == "error_by_class":
            coeff["note"] = (
                "Fit rungs idle/normal/peak all have error_rate 0. "
                "OLS is the zero model. Per-class counts on the fit "
                "split are also zero; there is no non-zero class rate "
                "to estimate. Do not import the public Burst literature cell as owned data."
            )
        metrics[metric_name] = coeff

    app_xs, app_ys = _series_points(fit_obs, "app_cpu_avg")
    db_xs, db_ys = _series_points(fit_obs, "db_cpu")
    app = ols_affine(app_xs, app_ys)
    app["predicts"] = "app_cpu_avg"
    db = ols_affine(db_xs, db_ys)
    db["predicts"] = "db_cpu"
    metrics["cpu"] = {
        "form": AFFINE_FORM,
        "app": app,
        "db": db,
        "note": (
            "Two independent affines on target RPS. Idle/normal app_cpu_avg "
            "is the mean of the two published app-host CPUs. Peak uses the "
            "published tilde values."
        ),
    }
    return metrics


def predict_measured_fields(metrics: dict[str, Any], target_rps: float) -> dict[str, float]:
    return {
        "goodput": predict_affine(metrics["goodput"], target_rps),
        "p50": predict_affine(metrics["p50"], target_rps),
        "p95": predict_affine(metrics["p95"], target_rps),
        "p99": predict_affine(metrics["p99"], target_rps),
        "error_rate": predict_affine(metrics["error_by_class"], target_rps),
        "app_cpu_avg": predict_affine(metrics["cpu"]["app"], target_rps),
        "db_cpu": predict_affine(metrics["cpu"]["db"], target_rps),
        "db_conn_max": predict_affine(metrics["connections"], target_rps),
    }


def delta_fields(measured: dict, predicted: dict) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for key in MEASURED_FIELD_NAMES:
        meas = measured.get(key)
        pred = predicted.get(key)
        if meas is None or pred is None:
            out[key] = None
        else:
            out[key] = float(meas) - float(pred)
    return out


def apply_fit_to_payload(payload: dict, metrics: dict[str, Any]) -> dict:
    payload = dict(payload)
    payload["metrics"] = metrics
    deltas = payload.get("holdout_deltas")
    if not isinstance(deltas, dict):
        print("coefficients holdout_deltas missing; cannot apply predictions", file=sys.stderr)
        raise HonestyError(1)
    updated: dict[str, Any] = {}
    for key, entry in deltas.items():
        if not isinstance(entry, dict):
            print(f"holdout {key} is not a mapping", file=sys.stderr)
            raise HonestyError(1)
        scenario = run_id_scenario(str(entry.get("run_id") or key))
        target = entry.get("target_rps")
        if target is None:
            target = SCENARIO_TARGET_RPS.get(scenario)
        if target is None:
            print(f"holdout {key} missing target_rps", file=sys.stderr)
            raise HonestyError(1)
        predicted = predict_measured_fields(metrics, float(target))
        measured = entry.get("measured") or {}
        new_entry = dict(entry)
        new_entry["target_rps"] = float(target)
        new_entry["fit_prediction"] = predicted
        new_entry["delta"] = delta_fields(measured, predicted)
        updated[key] = new_entry
    payload["holdout_deltas"] = updated
    return payload


def _floats_close(left: object, right: object) -> bool:
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return math.isclose(
            float(left), float(right), rel_tol=FLOAT_REL_TOL, abs_tol=FLOAT_ABS_TOL
        )
    return left == right


def _nested_close(left: object, right: object) -> bool:
    if isinstance(left, dict) and isinstance(right, dict):
        if set(left) != set(right):
            return False
        return all(_nested_close(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return False
        return all(_nested_close(a, b) for a, b in zip(left, right))
    return _floats_close(left, right)


def fitted_payload_matches(committed: dict, recomputed: dict) -> list[str]:
    errors: list[str] = []
    if committed.get("measurement_sha") != recomputed.get("measurement_sha"):
        errors.append("measurement_sha differs")
    if committed.get("fit_split") != recomputed.get("fit_split"):
        errors.append("fit_split differs")
    if not _nested_close(committed.get("metrics"), recomputed.get("metrics")):
        errors.append("metrics do not match recomputed OLS")
    left_hold = committed.get("holdout_deltas") or {}
    right_hold = recomputed.get("holdout_deltas") or {}
    if set(left_hold) != set(right_hold):
        errors.append("holdout_deltas keys differ")
        return errors
    for key in left_hold:
        left = left_hold[key]
        right = right_hold[key]
        if not _nested_close(left.get("fit_prediction"), right.get("fit_prediction")):
            errors.append(f"{key}.fit_prediction does not match recomputed model")
        if not _nested_close(left.get("delta"), right.get("delta")):
            errors.append(f"{key}.delta does not match recomputed model")
    return errors


def _yaml_number(value: float | int) -> str:
    if isinstance(value, bool):
        raise TypeError("boolean is not a coefficient number")
    if isinstance(value, int):
        return str(value)
    number = float(value)
    if number == 0.0:
        return "0.0"
    return repr(number)


def _render_affine(coeff: dict, indent: str) -> list[str]:
    lines = [
        f"{indent}form: {AFFINE_FORM}",
        f"{indent}intercept: {_yaml_number(coeff['intercept'])}",
        f"{indent}slope: {_yaml_number(coeff['slope'])}",
        f"{indent}residual_sum_squares: {_yaml_number(coeff['residual_sum_squares'])}",
        f"{indent}n_fit: {int(coeff['n_fit'])}",
        f"{indent}predicts: {coeff['predicts']}",
    ]
    note = coeff.get("note")
    if note:
        lines.append(f"{indent}note: {json.dumps(note)}")
    return lines


def _render_measured_block(fields: dict, indent: str) -> list[str]:
    lines = []
    for key in MEASURED_FIELD_NAMES:
        if key not in fields:
            continue
        value = fields[key]
        if value is None:
            lines.append(f"{indent}{key}: null")
        else:
            lines.append(f"{indent}{key}: {_yaml_number(value)}")
    return lines


def render_coefficients_yaml(payload: dict) -> str:
    lines = [
        "# Per-metric OLS coefficients from owned Admin Benchmarks campaign",
        "# 473f1339-f712-4096-96d6-3d4fc07cb427.",
        "# Fit split: idle / normal / peak only. Burst and other holdouts",
        "# are not in the fit. Form is affine_in_target_rps:",
        "#   model = intercept + slope * target_rps",
        "# Loss is per-metric sum of squared residuals. No composite score.",
        "# Do not copy the public Burst literature cell as owned data.",
        f"measurement_sha: {payload['measurement_sha']}",
        "fit_split:",
        "  run_ids:",
    ]
    for run_id in payload["fit_split"]["run_ids"]:
        lines.append(f"    - {run_id}")
    lines.append("holdout_deltas:")
    for key in (
        "burst",
        "pool-bound",
        "app-bound",
        "cpu-only",
        "later-day",
        "second-region",
    ):
        entry = payload["holdout_deltas"][key]
        lines.append(f"  {key}:")
        lines.append(f"    run_id: {entry['run_id']}")
        if entry.get("campaign_id"):
            lines.append(f"    campaign_id: {entry['campaign_id']}")
        if entry.get("origin_run_id"):
            lines.append(f"    origin_run_id: {entry['origin_run_id']}")
        if entry.get("target_rps") is not None:
            lines.append(f"    target_rps: {_yaml_number(entry['target_rps'])}")
        lines.append("    measured:")
        lines.extend(_render_measured_block(entry["measured"], "      "))
        lines.append("    fit_prediction:")
        lines.extend(_render_measured_block(entry["fit_prediction"], "      "))
        lines.append("    delta:")
        lines.extend(_render_measured_block(entry["delta"], "      "))
    created = payload.get("created_at")
    lines.append(f'created_at: "{created}"' if created else "created_at: null")
    lines.append("metrics:")
    cpu = payload["metrics"]["cpu"]
    lines.append("  cpu:")
    lines.append(f"    form: {AFFINE_FORM}")
    lines.append("    app:")
    lines.extend(_render_affine(cpu["app"], "      "))
    lines.append("    db:")
    lines.extend(_render_affine(cpu["db"], "      "))
    if cpu.get("note"):
        lines.append(f"    note: {json.dumps(cpu['note'])}")
    for name in ("p50", "p95", "p99", "goodput", "error_by_class", "connections"):
        lines.append(f"  {name}:")
        lines.extend(_render_affine(payload["metrics"][name], "    "))
    lines.append("")
    return "\n".join(lines)


def write_coefficients(path: Path, payload: dict) -> None:
    path.write_text(render_coefficients_yaml(payload))


def intended_fit(runs: list[dict]) -> None:
    fit = [r for r in runs if r.get("split") == "fit"]
    burst_in_fit = [
        r["run_id"]
        for r in fit
        if r.get("scenario") == "burst"
        or r.get("diagnostic") in ("pool-bound", "app-bound", "cpu-only")
    ]
    if burst_in_fit:
        print(
            "Burst (or pool-bound burst diagnostic) is in the fit split; "
            "hold Burst out. Refusing to fit.",
            file=sys.stderr,
        )
        raise HonestyError(2)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        return _main(argv)
    except HonestyError as exc:
        return int(exc.code)


def _main(argv: list[str]) -> int:
    refuse_composite(argv)

    parser = argparse.ArgumentParser(
        description="Per-metric OLS calibration. Refuses composite scores."
    )
    parser.add_argument(
        "--runs",
        nargs="*",
        default=None,
        help="Schema-valid run JSON files (isExample=true files are ignored).",
    )
    parser.add_argument(
        "--fit-input",
        default=str(FIT_INPUT_PATH),
        help="Published owned fit-rung YAML (default: calibrate/fit_input.yaml).",
    )
    parser.add_argument(
        "--check-provenance",
        action="store_true",
        help="Validate coefficients.yaml provenance fields.",
    )
    parser.add_argument(
        "--coefficients",
        default=str(COEFFICIENTS_PATH),
        help="Path to coefficients.yaml",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write fitted metrics and holdout predictions to --coefficients.",
    )
    args = parser.parse_args(argv)

    if args.check_provenance:
        return check_provenance(Path(args.coefficients))

    observations: list[dict] = []
    if args.runs:
        paths = [Path(p) for p in args.runs]
        runs = load_runs(paths)
        intended_fit(runs)
        observations = observations_from_runs(runs)
        if not observations:
            print("no measurements yet")
            return 0
    else:
        fit_input = Path(args.fit_input)
        if not fit_input.is_file():
            print("no measurements yet")
            return 0
        observations = load_fit_input(fit_input)

    metrics = fit_metrics(observations)
    coefficients_path = Path(args.coefficients)
    if yaml is None:
        print("PyYAML is required to update coefficients.yaml", file=sys.stderr)
        return 1
    committed = yaml.safe_load(coefficients_path.read_text())
    if not isinstance(committed, dict):
        print(f"{coefficients_path}: not a mapping", file=sys.stderr)
        return 1
    recomputed = apply_fit_to_payload(committed, metrics)

    if args.write:
        write_coefficients(coefficients_path, recomputed)
        print(
            "wrote per-metric OLS coefficients for idle/normal/peak; "
            "holdout fit_prediction/delta updated"
        )
        return check_provenance(coefficients_path)

    errors = fitted_payload_matches(committed, recomputed)
    if errors:
        print(
            f"{coefficients_path}: does not match recomputed per-metric OLS",
            file=sys.stderr,
        )
        for err in errors:
            print(f"  {err}", file=sys.stderr)
        print("re-run with --write after reviewing the fit", file=sys.stderr)
        return 1
    print(
        "fitted per-metric OLS on idle/normal/peak; "
        "coefficients.yaml matches; Burst held out"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except HonestyError as exc:
        sys.exit(exc.code)
