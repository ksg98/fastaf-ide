#!/usr/bin/env bash
# Catches stale native build defaults targeting an older OS than the app bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -B - <<'PY'
import json
from pathlib import Path
import re

config = Path("src-tauri/.cargo/config.toml").read_text()
bundle = json.loads(Path("src-tauri/tauri.conf.json").read_text())
target = bundle["bundle"]["macOS"]["minimumSystemVersion"]
# Read the two known inline settings without requiring Python 3.11's tomllib.
for key in ("MACOSX_DEPLOYMENT_TARGET", "CMAKE_OSX_DEPLOYMENT_TARGET"):
    settings = re.findall(
        rf'^\s*{key}\s*=\s*\{{\s*value\s*=\s*"([^"]+)"\s*,\s*force\s*=\s*(true|false)\s*\}}\s*(?:#.*)?$',
        config,
        re.M,
    )
    assert len(settings) == 1, f"{key} must have one explicit value and force setting"
    value, force = settings[0]
    assert force == "true", (
        f"Inherited shell {key} must not override the app minimum"
    )
    assert value == target, (
        f"{key} target {value} differs from the app bundle minimum {target}"
    )
makefile = Path("Makefile").read_text()
assert not re.search(r"^export MACOSX_DEPLOYMENT_TARGET\s*[:?+]?=", makefile, re.M), (
    "Make must inherit the Cargo default instead of overriding it"
)
print(f"macOS deployment target: Cargo, CMake and bundle agree on {target}")
PY
