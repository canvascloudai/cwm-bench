#!/usr/bin/env python3
"""Validate EXAMPLE fixtures against draft 2020-12 schemas."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def validate(instance_path: Path, schema_path: Path) -> list[str]:
    schema = load(schema_path)
    instance = load(instance_path)
    validator = Draft202012Validator(schema)
    return [
        f"{instance_path}: {e.json_path}: {e.message}"
        for e in validator.iter_errors(instance)
    ]


def main() -> int:
    errors: list[str] = []
    errors.extend(
        validate(
            ROOT / "schema" / "example-run.json",
            ROOT / "schema" / "run.schema.json",
        )
    )
    errors.extend(
        validate(
            ROOT / "schema" / "example-campaign.json",
            ROOT / "schema" / "campaign.schema.json",
        )
    )

    example = load(ROOT / "schema" / "example-run.json")
    if example.get("isExample") is not True:
        errors.append("schema/example-run.json must set isExample: true")
    if "EXAMPLE" not in str(example.get("campaign_id", "")):
        errors.append("schema/example-run.json campaign_id must be marked EXAMPLE")

    campaign = load(ROOT / "schema" / "example-campaign.json")
    if campaign.get("isExample") is not True:
        errors.append("schema/example-campaign.json must set isExample: true")

    if errors:
        for line in errors:
            print(line, file=sys.stderr)
        return 1
    print("schema fixtures valid (EXAMPLE only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
