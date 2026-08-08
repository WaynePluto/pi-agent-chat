#!/usr/bin/env python3
"""Require exact SemVer strings for direct runtime and development dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE_JSON = ROOT / "package.json"
SECTIONS = ("dependencies", "devDependencies")
EXACT_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def main() -> None:
    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    invalid: list[str] = []

    for section in SECTIONS:
        for name, version in package.get(section, {}).items():
            if not isinstance(version, str) or EXACT_SEMVER.fullmatch(version) is None:
                invalid.append(f"{section}.{name}={version}")

    if invalid:
        print("[fail] direct dependencies must use exact versions (no ^, ~, tags, or ranges):")
        for item in invalid:
            print(f"       {item}")
        sys.exit(1)

    print("[ok]   all direct dependencies use exact versions")


if __name__ == "__main__":
    main()
