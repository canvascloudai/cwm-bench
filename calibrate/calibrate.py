#!/usr/bin/env python3
"""Per-metric calibration stub for cwm-bench.

Honesty rules (also in README, CONTRIBUTING, and CI):
  1. Never optimize the composite accuracy score.
  2. Fit per-metric only (CPU, P50/P95/P99, goodput, error-by-class,
     connections) on a declared fit split.
  3. Hold out Burst, plus a later day and a second region.
  4. Coefficients ship with measurement SHA, fit split, holdout deltas.
     A coefficients change without a new measurement ID is rejected.
  5. v1 owned holdout measurements may be recorded with null metrics.
     Do not invent coefficients. Do not copy the public 2%/9.55% cell
     as owned data. Cost from the price list can be measured.
  6. gp2 BurstBalance hitting 0 is a THIRD error bucket, distinct from
     CPU failures and DB connection failures.

Intended loss (documented, not computed — coefficients are not fitted):

    For each metric M in {cpu, p50, p95, p99, goodput, error_by_class, connections}:
        L(M) = sum_{run in fit_split} (model(M, run) - measured(M, run))^2

    Fit each L(M) independently (ordinary least squares).
    Do not form a weighted sum of L(M) and do not search for
    coefficients that raise a composite accuracy score.

    Burst runs, later-day runs, and second-region runs are holdout.
    They appear in holdout_deltas. Measured-only stubs set
    fit_prediction to null.

This script:
  * Reads schema-valid runs from --runs (default: no files).
  * Refuses to compute or optimize a composite accuracy score
    (exit 2 if asked).
  * Would fit per-metric on split=fit only; currently prints
    "no measurements yet" and exits 0 (no run JSON + no fitter).
  * --check-provenance validates coefficients.yaml against the
    provenance schema, rejects Burst in fit_split, rejects fitted
    metrics without a measurement_sha, and allows measured-only
    holdout_deltas (fit_prediction null while metrics.* are null).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - CI installs PyYAML
    yaml = None


REPO_ROOT = Path(__file__).resolve().parents[1]
COEFFICIENTS_PATH = Path(__file__).resolve().parent / "coefficients.yaml"
COEFFICIENTS_SCHEMA_PATH = Path(__file__).resolve().parent / "coefficients.schema.yaml"
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

COMPOSITE_FLAGS = (
    "composite",
    "composite-score",
    "optimize-score",
    "accuracy-score",
    "overall-score",
    "score",
)


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
    any_fit = any(metrics.get(name) is not None for name in metrics)
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
    return 0


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
    # No implementation on purpose: there is nothing to fit.
    _ = fit


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    refuse_composite(argv)

    parser = argparse.ArgumentParser(
        description="Per-metric calibration stub. Refuses composite scores."
    )
    parser.add_argument(
        "--runs",
        nargs="*",
        default=[],
        help="Schema-valid run JSON files (isExample=true files are ignored).",
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
    args = parser.parse_args(argv)

    if args.check_provenance:
        return check_provenance(Path(args.coefficients))

    paths = [Path(p) for p in args.runs]
    runs = load_runs(paths) if paths else []
    if not runs:
        print("no measurements yet")
        return 0

    intended_fit(runs)
    print("no measurements yet")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except HonestyError as exc:
        sys.exit(exc.code)
