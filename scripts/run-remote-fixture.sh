#!/usr/bin/env bash
# Fixture only: binary MUST be built with --no-default-features --features tuic-core/test-support.
# This uses the existing test config fallback, so no production config directory is written.
# Share this launcher for remote MCP, detection and browser-grid verification.
set -euo pipefail
fixture_binary="${1:?usage: run-remote-fixture.sh <test-support binary> [port] [instance]}"
fixture_port="${2:-19877}"
fixture_instance="${3:-tuic-remote-fixture}"
if [[ ! "$fixture_instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Invalid fixture instance" >&2; exit 2
fi
export TMPDIR="$HOME/Gits/.tmp/tuic-1421/"
export TUIC_TEST_TMP_ROOT="$HOME/Gits/.tmp/tuic-remote-fixture/$fixture_instance/"
export PAGER=cat GIT_PAGER=cat
mkdir -p "$TMPDIR" "$TUIC_TEST_TMP_ROOT"
export TUIC_PORT="$fixture_port"
export TUIC_PAIRING_TOKEN="${TUIC_FIXTURE_TOKEN:-tuic-1421-fixture}"
echo "Fixture URL: http://127.0.0.1:$fixture_port (instance $fixture_instance)"
exec "$fixture_binary" --instance "$fixture_instance" --bind 127.0.0.1 --no-agent-configs
