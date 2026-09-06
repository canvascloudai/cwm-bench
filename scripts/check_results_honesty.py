#!/usr/bin/env python3
"""Reject claimed measurements under results/.

Honesty: do not commit a file that claims isExample=false under results/.
The v1 owned campaign is published in holdout/ and calibrate/ (fitted
per-metric from those published values). EXAMPLE fixtures live in
schema/, not here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"

FALSE_TOKENS = (
    '"isExample": false',
    '"isExample":false',
    "isExample: false",
    "isExample:false",
)


def main() -> int:
    bad: list[str] = []
    if not RESULTS.exists():
        print("results/ missing", file=sys.stderr)
        return 1

    for path in RESULTS.rglob("*"):
        if not path.is_file():
            continue
        if path.name == ".gitkeep":
            continue
        if path.name == "README.md":
            continue
        text = path.read_text(errors="replace")
        lowered = text.replace(" ", "")
        if '"isExample":false' in lowered or "isExample:false" in lowered.replace(
            "'", '"'
        ):
            bad.append(str(path.relative_to(ROOT)))
            continue
        if path.suffix == ".json":
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and payload.get("isExample") is False:
                bad.append(str(path.relative_to(ROOT)))

    if bad:
        print(
            "results/ contains a claimed measurement (isExample=false). "
            "Do not commit run JSON here; publish via holdout/:",
            file=sys.stderr,
        )
        for item in bad:
            print(f"  {item}", file=sys.stderr)
        return 1
    print("results/ honesty check passed (no isExample=false)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
