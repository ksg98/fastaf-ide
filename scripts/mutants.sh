#!/usr/bin/env bash
# Mutation-test the Rust changes of a git range with cargo-mutants.
#
#   scripts/mutants.sh [RANGE]      default RANGE=HEAD~1 (that commit vs HEAD)
#
# Tests the committed tree at HEAD: commit first. Only mutants overlapping the
# diff run (`--in-diff`); a full-tree run is N mutants x one incremental build
# of the lib crate and is deliberately not offered.
#
# Runs `--in-place` in a disposable local CLONE under .tmp/ instead of the copy
# cargo-mutants makes by default: `tauri::generate_context!` needs `../dist`
# next to src-tauri, which a copy of the workspace root does not have, and the
# copy would land in $TMPDIR where every freshly built test binary is scanned
# on exec. `--in-place` implies one job, which is also the budget.
#
# A clone, not a worktree: a detached worktree is an "orphan" to a running
# FastAF, and its orphan cleanup removes it on the next repo refresh —
# mid-run, with the mutant applied. A clone is an independent repository, absent
# from .git/worktrees, so that cleanup cannot see it.
#
# A clone, not `git archive` — but NOT because the suite needs the surrounding
# history any more. That used to be the reason: twelve tests in git.rs called
# get_commit_log and friends on `env!("CARGO_MANIFEST_DIR")/..`, the repository
# they sit in, and get_commit_log rejects a path that is not a repository
# rather than letting git discover one upward, so in a plain export the
# BASELINE run failed on `get_commit_log_count_clamped_to_500` and no mutant
# was tested. #772-f7c2 made those tests build their own fixture repositories;
# measured 2026-09-14, the whole `--lib` suite passes in an export (5197 run,
# 5197 passed), so an export would work here now.
#
# The clone stays because it costs nothing to keep and answers more questions:
# `--local` hardlinks the object store, so the history is not copied, and a
# real repository keeps `checkout --detach` available and leaves cargo-mutants
# free to consult git. Switching to an export would buy nothing and would put
# that last assumption back in play.
set -euo pipefail

RANGE="${1:-HEAD~1}"
ROOT="$(git rev-parse --show-toplevel)"
case "${TMPDIR:-}" in
  "$ROOT/"*|"$HOME/Gits/"*) TEST_TMP_BASE="${TMPDIR%/}" ;;
  *) TEST_TMP_BASE="$ROOT/.tmp/tuic-tests" ;;
esac
mkdir -p "$TEST_TMP_BASE"
TEST_TMP="$(mktemp -d "$TEST_TMP_BASE/tuic-mutants.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT
export TMPDIR="$TEST_TMP/"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export TUIC_TEST_TMP_ROOT="$TEST_TMP"
SRC="$ROOT/.tmp/mutants-src"
DIFF="$ROOT/.tmp/mutants.diff"

# Every cargo call goes through the mbx shim when it is installed (shared
# artifact cache + machine-wide compile scheduler); CI has no mbx and runs
# plain cargo.
MBX_BIN="$HOME/Library/Application Support/mbx/bin"
[ -d "$MBX_BIN" ] && export PATH="$MBX_BIN:$PATH"

command -v cargo-mutants >/dev/null || { echo "cargo-mutants missing: cargo install --locked cargo-mutants"; exit 1; }
[ -d "$ROOT/dist" ] || { echo "$ROOT/dist missing — run 'pnpm exec vite build' first"; exit 1; }
ls "$ROOT/src-tauri/binaries"/tuic-bridge-* >/dev/null 2>&1 || { echo "sidecar missing — run 'pnpm build:sidecar' first"; exit 1; }

mkdir -p "$ROOT/.tmp"
# Paths relative to src-tauri, with the b/ prefix --in-diff expects.
git -C "$ROOT" diff --relative=src-tauri "$RANGE" HEAD -- src-tauri > "$DIFF"
if ! grep -q '^+++ b/.*\.rs$' "$DIFF"; then
  echo "no Rust changes in $RANGE..HEAD"; exit 0
fi

# A fresh clone every run: an interrupted run leaves a mutant applied in the
# working tree, and starting from a known-clean checkout is cheaper to reason
# about than restoring one.
rm -rf "$SRC"
# `--local` hardlinks the object store: the 145 MB of history costs no copy.
git clone --local --quiet "$ROOT" "$SRC"
git -C "$SRC" checkout --quiet --detach "$(git -C "$ROOT" rev-parse HEAD)"
# generate_context! embeds ../dist; tauri-build checks the gitignored sidecar.
mkdir -p "$SRC/dist" "$SRC/src-tauri/binaries"
cp -R "$ROOT/dist/." "$SRC/dist/"
# The clone already contains tracked sidecars. Never overwrite that inode:
# code-signature caches and concurrent readers must keep the old bytes.
for source in "$ROOT"/src-tauri/binaries/*; do
  [[ -f "$source" ]] || continue
  name="${source##*/}"
  staged="$SRC/src-tauri/binaries/.$name.update.$$"
  cp -p "$source" "$staged"
  mv -f "$staged" "$SRC/src-tauri/binaries/$name"
done

cd "$SRC/src-tauri"
ulimit -n 10240
# `|| STATUS=$?` rather than a bare call: cargo-mutants exits non-zero exactly
# when mutants SURVIVED, and under `set -e` that aborted the script here — so
# the missed.txt dump below only ever printed on a clean run, which is the one
# case where it has nothing to say.
STATUS=0
cargo mutants --workspace --in-place --in-diff "$DIFF" "${@:2}" || STATUS=$?
echo "--- missed (a surviving mutant is a missing test):"
cat mutants.out/missed.txt 2>/dev/null || true
echo "logs: $SRC/src-tauri/mutants.out"
exit $STATUS
