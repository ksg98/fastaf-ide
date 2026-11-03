#!/usr/bin/env bash
# sync-upstream.sh — bring sstraus/tuicommander changes into FastAF as ONE commit.
#
#   scripts/sync-upstream.sh [--base <sha>] [upstream-ref]    (default ref: upstream/main)
#
# FastAF's history holds no upstream commits: every sync is a single commit whose
# `Upstream-Synced: sstraus/tuicommander@<sha>` trailer records what it brought in.
# A plain `git merge upstream/main` would drag all of upstream's history back into
# FastAF's, and `git merge --squash` on its own finds no merge base. So this grafts
# the last synced upstream commit onto the last sync commit for the length of one
# squash merge (a real 3-way merge), then removes the graft. Nothing is committed:
# resolve any conflicts, run the checks, then `git commit` (the message is prefilled).
#
#   --base <sha>   the upstream commit the last sync matches, when the one in the
#                  trailer is gone because upstream rewrote its history

set -euo pipefail

UPSTREAM_URL="https://github.com/sstraus/tuicommander.git"
BASE=""
REF="upstream/main"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--base) BASE="$2"; shift 2 ;;
		-h|--help) sed -n '2,15p' "$0"; exit 0 ;;
		*) REF="$1"; shift ;;
	esac
done

die() { echo "error: $*" >&2; exit 1; }

# Upstream rewrote its history in Oct 2026, so commits named by older trailers no
# longer exist there. Each maps to its rewritten twin (same subject and author date).
rewritten_twin() {
	case "$1" in
		e4d7efd6c852bfdb8a5dfbb14be9fca33cd48244) echo c4405e00356a45c912ecd4625838885567435687 ;;
	esac
}

[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "commit or stash tracked changes first"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
# Upstream's tags reuse FastAF's version numbers, and pushing one would start a
# release of upstream's code from this repo. Never fetch them.
git config remote.upstream.tagOpt --no-tags
git fetch --no-tags upstream

NEW=$(git rev-parse --verify "$REF^{commit}")
LAST=$(git log -1 --format=%H --grep='^Upstream-Synced: ' HEAD)
[[ -n "$LAST" ]] || die "no earlier sync commit (Upstream-Synced trailer) on this branch"
if [[ -z "$BASE" ]]; then
	BASE=$(git log -1 --format=%B "$LAST" | sed -n 's#^Upstream-Synced: sstraus/tuicommander@\([0-9a-f]\{40\}\).*#\1#p' | tail -1)
	twin=$(rewritten_twin "$BASE")
	if [[ -n "$twin" ]]; then BASE=$twin; fi
fi
BASE=$(git rev-parse --verify --quiet "$BASE^{commit}") || die "upstream commit $BASE is not here; pass --base <sha>"

if ! git merge-base --is-ancestor "$BASE" "$NEW"; then
	# Upstream rewrote its history again: look for the same commit in the new one.
	key=$(git log -1 --format='%ad %s' --date=unix "$BASE")
	match=$(git log "$NEW" --format='%H %ad %s' --date=unix | awk -v k="$key" 'substr($0, 42) == k { print $1 }')
	[[ $(printf '%s' "$match" | grep -c .) -eq 1 ]] || die "$REF no longer contains $BASE and no single commit matches it; pass --base <sha>"
	echo "==> upstream rewrote its history; using $(git log -1 --format='%h %s' "$match") as the base"
	BASE=$match
fi
if [[ "$BASE" = "$NEW" ]]; then echo "==> already up to date with $REF"; exit 0; fi

COUNT=$(git rev-list --count "$BASE..$NEW")
VERSION=$(git show "$NEW:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')
echo "==> squashing $COUNT upstream commits, $(git rev-parse --short "$BASE")..$(git rev-parse --short "$NEW") (v${VERSION:-?})"

# shellcheck disable=SC2046 # split on purpose: one argument per existing parent
git replace --graft "$LAST" $(git rev-parse "$LAST^@") "$BASE"
trap 'git replace -d "$LAST" >/dev/null 2>&1 || true' EXIT

rc=0
git merge --squash "$NEW" || rc=$?

# --squash fills the message with every upstream commit's log; replace it.
msg="chore(upstream): sync TUICommander v${VERSION:-?} ($COUNT commits)

Brings sstraus/tuicommander $(git rev-parse --short "$BASE")..$(git rev-parse --short "$NEW") into FastAF as one
commit, so upstream's history stays out of FastAF's.

Upstream-Synced: sstraus/tuicommander@$NEW"
for f in SQUASH_MSG MERGE_MSG; do
	path=$(git rev-parse --git-path "$f")
	if [[ -f "$path" || "$f" = SQUASH_MSG ]]; then printf '%s\n' "$msg" > "$path"; fi
done

if [[ $rc -ne 0 ]]; then
	echo "==> conflicts in $(git diff --name-only --diff-filter=U | wc -l | tr -d ' ') files. Resolve them hunk by hunk"
	echo "    (never \`checkout --ours/--theirs\` a whole file: it drops the other side's changes), then:"
else
	echo "==> merged cleanly. Next:"
fi
echo "    git grep -n TUICommander    # keep FastAF naming; the README credit stays"
echo "    run tsc, biome, vitest and the cargo checks, then: git commit"
