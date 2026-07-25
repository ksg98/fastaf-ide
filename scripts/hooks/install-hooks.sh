#!/usr/bin/env bash
#
# install-hooks.sh — symlink the tracked hooks in scripts/hooks/ into .git/hooks/.
# Idempotent; safe to run repeatedly (e.g. from `make dev`). Never clobbers a
# real (non-symlink) hook — those belong to other tooling (e.g. the HUD plugin's
# post-commit) and are left untouched with a warning.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
src_dir="$repo_root/scripts/hooks"
git_hooks="$(git rev-parse --git-path hooks)"
mkdir -p "$git_hooks"

for src in "$src_dir"/*; do
  name="$(basename "$src")"
  [ "$name" = "install-hooks.sh" ] && continue
  [ -f "$src" ] || continue

  dest="$git_hooks/$name"

  if [ -L "$dest" ]; then
    ln -sf "$src" "$dest"
    echo "hooks: linked $name"
  elif [ -e "$dest" ]; then
    echo "hooks: SKIP $name — real file already at $dest (remove it to enable)" >&2
  else
    ln -s "$src" "$dest"
    echo "hooks: linked $name"
  fi
done
