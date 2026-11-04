#!/usr/bin/env bash
# Prints the GitHub release flags for a version, in $GITHUB_OUTPUT format.
# A semver prerelease (a "-" before any "+build" metadata, e.g. 2.0.0-beta.1)
# publishes as a prerelease and never as "latest": the stable updater endpoint
# (releases/latest/download/latest.json) and install scripts read "latest".
#
#   scripts/release-flags.sh <version>   e.g. 2.0.0-beta.1
set -euo pipefail

version=${1:?usage: release-flags.sh <version>}
core=${version%%+*}
if [[ "$core" == *-* ]]; then
  printf 'prerelease=true\nlatest=false\n'
else
  printf 'prerelease=false\nlatest=true\n'
fi
