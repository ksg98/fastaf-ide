#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
fixture=$(mktemp -d "${TMPDIR:?}/tuic-union-merge.XXXXXX")
trap 'rm -rf "$fixture"' EXIT

git -C "$fixture" init -q -b main
git -C "$fixture" config user.name "Union Merge Test"
git -C "$fixture" config user.email "union-merge@example.invalid"
if [[ -f "$repo_root/.gitattributes" ]]; then
  cp "$repo_root/.gitattributes" "$fixture/.gitattributes"
fi
printf '# Changelog\n\n## [Unreleased]\n' > "$fixture/CHANGELOG.md"
printf '# Manual tests\n\n## Pending\n' > "$fixture/to-test.md"
git -C "$fixture" add -A
git -C "$fixture" commit -qm base

git -C "$fixture" checkout -qb left
printf '%s\n' '- Left branch entry' >> "$fixture/CHANGELOG.md"
printf '%s\n' '- Left branch check' >> "$fixture/to-test.md"
git -C "$fixture" commit -qam left

git -C "$fixture" checkout -q main
printf '%s\n' '- Right branch entry' >> "$fixture/CHANGELOG.md"
printf '%s\n' '- Right branch check' >> "$fixture/to-test.md"
git -C "$fixture" commit -qam right

if ! git -C "$fixture" merge --no-edit left; then
  echo "Append-only branch merge conflicted" >&2
  exit 1
fi

grep -Fqx -- '- Left branch entry' "$fixture/CHANGELOG.md"
grep -Fqx -- '- Right branch entry' "$fixture/CHANGELOG.md"
grep -Fqx -- '- Left branch check' "$fixture/to-test.md"
grep -Fqx -- '- Right branch check' "$fixture/to-test.md"
test "$(git -C "$fixture" check-attr merge -- SPEC.md)" = 'SPEC.md: merge: unspecified'
test "$(git -C "$fixture" check-attr merge -- src/main.rs)" = 'src/main.rs: merge: unspecified'
test "$(git -C "$fixture" check-attr merge -- docs/CHANGELOG.md)" = 'docs/CHANGELOG.md: merge: unspecified'
echo "Both append-only files retained both branches; SPEC.md and code retain default merging."
