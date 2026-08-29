#!/usr/bin/env python3
"""Per-metric calibration stub for cwm-bench.

Honesty rules (also in README, CONTRIBUTING, and CI):
  1. Never optimize the composite accuracy score.
  2. Fit per-metric only (CPU, P50/P95/P99, goodput, error-by-class,
     connections) on a declared fit split.
  3. Hold out Burst, plus a later day and a second region.
  4. Coefficients ship with measurement SHA, fit split, holdout deltas.
     A coefficients change without a new measurement ID is rejected.
  5. Until v1 measurements exist: keep Burst error visible as a known
     gap OR leave the floor failing. Do not label latency/CPU/throughput/
     error as "measured". Cost from the price list can be measured.
  6. gp2 BurstBalance hitting 0 is a THIRD error bucket, distinct from
     CPU failures and DB connection failures.

Intended loss (documented, not computed — there are no measurements yet):

    For each metric M in {cpu, p50, p95, p99, goodput, error_by_class, connections}:
        L(M) = sum_{run in fit_split} (model(M, run) - measured(M, run))^2

    Fit each L(M) independently (ordinary least squares).
    Do not form a weighted sum of L(M) and do not search for
    coefficients that raise a composite accuracy score.

    Burst runs, later-day runs, and second-region runs are holdout.
    They appear only in holdout_deltas after a fit exists.

This script:
  * Reads schema-valid runs from --runs (default: no files).
  * Refuses to compute or optimize a composite accuracy score
    (exit 2 if asked).
  * Would fit per-metric on split=fit only; currently prints
    "no measurements yet" and exits 0.
  * --check-provenance rejects coefficients.yaml that has any
    non-null metric without a measurement_sha.
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
RUN_SCHEMA_PATH = REPO_ROOT / "schema" / "run.schema.json"

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


def check_provenance(path: Path) -> int:
    if yaml is None:
        print("PyYAML is required for --check-provenance", file=sys.stderr)
        return 1
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        print(f"{path}: not a mapping", file=sys.stderr)
        return 1

    metrics = payload.get("metrics") or {}
    any_fit = any(metrics.get(name) is not None for name in metrics)
    sha = payload.get("measurement_sha")
    if any_fit and not sha:
        print(
            f"{path}: coefficients present without measurement_sha "
            "(a coefficients change without a new measurement ID is rejected)",
            file=sys.stderr,
        )
        return 1
    if any_fit and payload.get("fit_split") is None:
        print(f"{path}: coefficients present without fit_split", file=sys.stderr)
        return 1
    if any_fit and payload.get("holdout_deltas") is None:
        print(
            f"{path}: coefficients present without holdout_deltas",
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
