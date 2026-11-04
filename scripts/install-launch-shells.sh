#!/usr/bin/env bash
# Install the shells the shell-integration launch matrix requires, then prove
# each one can actually be launched the way the tests launch it.
#
#   scripts/install-launch-shells.sh
#
# The matrix lives in src-tauri/src/shell_integration.rs (LAUNCH_SHELLS) and is
# documented in AGENTS.md under "Validation". bash and zsh are on the runner
# images; fish is on none of them, which is why its half of the matrix had never
# executed anywhere.
#
# The verification below launches each shell rc-free rather than reading
# `--version`, because the failure this guards against is a shell that IS
# installed and still unusable: `--no-config` only exists in fish >= 3.3, and an
# older fish would be installed, be reported by `which`, and still fail every
# launch. Probing the capability pins the version by the only property the tests
# depend on.
set -euo pipefail

case "$(uname -s)" in
  Linux)
    sudo apt-get update
    sudo apt-get install -y fish zsh
    ;;
  Darwin)
    # zsh is the macOS login shell; only fish is missing.
    brew install fish
    ;;
  *)
    echo "the launch matrix is #[cfg(unix)] — nothing to install on $(uname -s)"
    exit 0
    ;;
esac

status=0
for shell in bash zsh fish; do
  case "$shell" in
    bash) flags=(--noprofile --norc) ;;
    zsh) flags=(-f) ;;
    fish) flags=(--no-config) ;;
  esac
  if "$shell" "${flags[@]}" -c 'exit 0' >/dev/null 2>&1; then
    echo "ok   $shell $("$shell" --version 2>&1 | head -1)"
  else
    echo "FAIL $shell cannot be launched with ${flags[*]}"
    status=1
  fi
done
exit $status
