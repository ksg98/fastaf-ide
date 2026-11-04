#!/usr/bin/env bash
# Exercise the version -> GitHub release flags mapping used by release.yml.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"

expect() {
  local version=$1 want=$2 got
  got=$(bash "$project_root/scripts/release-flags.sh" "$version")
  [[ "$got" == "$want" ]] || { printf 'release-flags %s:\n got: %s\nwant: %s\n' "$version" "$got" "$want" >&2; exit 1; }
}

stable=$'prerelease=false\nlatest=true'
pre=$'prerelease=true\nlatest=false'

# Catches: a stable release published as a prerelease, so stable users lose it.
expect 2.0.0 "$stable"
expect 1.10.3 "$stable"
# Catches: a beta published as latest, so releases/latest serves it to stable users.
expect 2.0.0-beta.1 "$pre"
expect 2.0.0-rc.2 "$pre"
# Catches: build metadata read as a prerelease, or a hyphen after it ignored.
expect 2.0.0+build-5 "$stable"
expect 2.0.0-beta.1+build-5 "$pre"
# Catches: an empty version silently mapped to a stable release.
if bash "$project_root/scripts/release-flags.sh" "" >/dev/null 2>&1; then
  echo "release-flags accepted an empty version" >&2
  exit 1
fi
echo "release-flags ok"
