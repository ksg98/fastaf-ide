#!/usr/bin/env bash
# Bugs caught: a verification launch targets production state/binaries, inherits
# unsafe listener overrides, or a dry run builds/starts a desktop app.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -B scripts/agent-test-tests.py
