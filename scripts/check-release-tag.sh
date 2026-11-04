#!/usr/bin/env bash
# Fails when a release tag does not match the version the bump wrote into the
# manifests. release.yml derives the release name from tauri.conf.json, so a tag
# pushed before `make bump` would overwrite the assets of the previous release.
#
#   scripts/check-release-tag.sh <tag> [repo-root]   e.g. v1.8.0
set -euo pipefail

check() {
  local tag=$1 root=$2 want=${1#v} bad=0 got file
  for file in src-tauri/tauri.conf.json package.json; do
    got=$(jq -r '.version' "$root/$file")
    [[ "$got" == "$want" ]] || { echo "::error::$file is $got but the tag is $tag" >&2; bad=1; }
  done
  got=$(awk '/^\[workspace.package\]/{on=1;next} /^\[/{on=0} on && /^version/{gsub(/"/,"",$3);print $3;exit}' "$root/src-tauri/Cargo.toml")
  [[ "$got" == "$want" ]] || { echo "::error::src-tauri/Cargo.toml [workspace.package] is $got but the tag is $tag" >&2; bad=1; }
  return $bad
}

check "${1:?usage: check-release-tag.sh <tag> [repo-root]}" "${2:-.}"
