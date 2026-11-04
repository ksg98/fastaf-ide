#!/usr/bin/env bash
# Compile the real desktop entry point separately from library unit tests.
# custom-protocol forces the bundled frontend path even when devUrl is configured.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cargo check --manifest-path "$root/src-tauri/Cargo.toml" -p tuicommander \
  --bin FastAF --features desktop,tauri/custom-protocol "$@"
