#!/usr/bin/env bash
# Catches: the deployment-target check requires tomllib, absent from the
# system Python on Ubuntu 22.04 CI and macOS, breaking make test-shell.
set -euo pipefail
cd "$(dirname "$0")/.."
PATH="/usr/bin:/bin:$PATH" bash scripts/test-macos-deployment-target.sh
