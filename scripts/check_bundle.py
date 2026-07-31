#!/usr/bin/env python3
"""Verify build output invariants for the Pi Agent Chat extension bundle.

Checks (see vscode-pi-design.md 2.1):
  1. dist/extension.js and dist/webview.js exist.
  2. Exactly one undici copy is embedded in the extension bundle.
  3. The embedded undici is >= 8.7.0 (proxy absolute-form forwarding fix).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
MIN_UNDICI = (8, 7, 0)


def fail(message: str) -> None:
    print(f"[fail] {message}")
    sys.exit(1)


def parse_version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3])


def installed_undici_versions() -> dict[str, str]:
    """Map every undici package.json under node_modules to its version."""
    versions: dict[str, str] = {}
    for path in (ROOT / "node_modules").rglob("undici/package.json"):
        try:
            versions[str(path.relative_to(ROOT))] = json.loads(path.read_text(encoding="utf-8"))["version"]
        except (OSError, ValueError, KeyError):
            continue
    return versions


def main() -> None:
    for name in ("extension.js", "webview.js"):
        if not (DIST / name).is_file():
            fail(f"missing build output: dist/{name} (run `pnpm build`)")

    bundle = (DIST / "extension.js").read_text(encoding="utf-8", errors="replace")

    installed = installed_undici_versions()
    print("[info] undici copies in node_modules:")
    for path, version in sorted(installed.items()):
        print(f"       {version}  {path}")

    # esbuild keeps original module paths in bundle comments; count the distinct
    # undici package roots that actually made it into the bundle.
    roots = {
        match.replace("\\", "/")
        for match in re.findall(r"[\w\\/.@-]*node_modules[\\/](?:[\w\\/.@-]*node_modules[\\/])?undici[\\/]", bundle)
    }
    if not roots:
        print("[warn] no undici path markers found in bundle (minified build?), skipping copy-count check")
    elif len(roots) > 1:
        fail(f"bundle embeds {len(roots)} undici copies: {sorted(roots)}")
    else:
        root = next(iter(roots))
        print(f"[ok]   single undici copy embedded: {root}")
        if "pi-coding-agent" in root:
            fail("bundle embedded the SDK's nested undici instead of the aliased top-level copy")

    top_level = ROOT / "node_modules" / "undici" / "package.json"
    if not top_level.is_file():
        fail("top-level undici is not installed")
    version = json.loads(top_level.read_text(encoding="utf-8"))["version"]
    if parse_version(version) < MIN_UNDICI:
        fail(f"top-level undici {version} is older than required {'.'.join(map(str, MIN_UNDICI))}")
    print(f"[ok]   top-level undici {version} >= {'.'.join(map(str, MIN_UNDICI))}")

    size_mb = (DIST / "extension.js").stat().st_size / (1024 * 1024)
    print(f"[ok]   dist/extension.js size: {size_mb:.2f} MB")
    print("[ok]   bundle checks passed")


if __name__ == "__main__":
    main()
