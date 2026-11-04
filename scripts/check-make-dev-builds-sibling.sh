#!/usr/bin/env bash
# Guard: `make dev` must build the sibling tuic-remote before it launches the
# desktop dev binary. Remote update from a dev build falls back to the
# tuic-remote next to the desktop executable (remote_deploy/assets.rs); without
# this step `pnpm tauri dev` builds only the desktop bin and the update fails
# with "locally built tuic-remote ... not found" (#1316-6a4a).
set -euo pipefail

cd "$(dirname "$0")/.."

out=$(env -u TUIC_APP_INSTANCE MAKEFLAGS= make -n dev 2>&1) || {
	echo "  ✗ make -n dev failed:"
	printf '%s\n' "$out" | sed 's/^/      /'
	exit 1
}

build_line=$(printf '%s\n' "$out" |
	grep -nE 'cargo build --bin tuic-remote --no-default-features' | head -1 | cut -d: -f1 || true)
launch_line=$(printf '%s\n' "$out" | grep -nE 'tauri dev' | head -1 | cut -d: -f1 || true)

if [ -z "$build_line" ]; then
	echo "  ✗ make dev does not build the sibling: no 'cargo build --bin tuic-remote --no-default-features'"
	exit 1
fi
if [ -z "$launch_line" ]; then
	echo "  ✗ make dev prints no 'tauri dev' launch line; this guard cannot order the steps"
	exit 1
fi
if [ "$build_line" -ge "$launch_line" ]; then
	echo "  ✗ make dev builds the sibling after launching tauri dev (line $build_line >= $launch_line)"
	exit 1
fi
