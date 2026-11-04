#!/usr/bin/env bash
#
# install-hooks.sh — install dispatchers in the shared Git hooks directory.
# Each dispatcher runs the hook from the checkout invoking Git. A linked
# worktree must not redirect hooks for every other worktree during `make dev`.
# Preserve real hooks owned by other tooling (e.g. HUD's post-commit).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
src_dir="$repo_root/scripts/hooks"
git_hooks="$(git rev-parse --git-path hooks)"
mkdir -p "$git_hooks"

temp=""
cleanup_temp() {
  [ -z "$temp" ] || rm -f "$temp" || true
}
trap cleanup_temp EXIT

for src in "$src_dir"/*; do
  name="$(basename "$src")"
  case "$name" in install-hooks.sh | test-*) continue ;; esac
  [ -f "$src" ] || continue

  dest="$git_hooks/$name"

  if [ -e "$dest" ] && [ ! -L "$dest" ] &&
     ! head -n 2 "$dest" | grep -Fqx '# tuic-managed-hook'; then
    echo "hooks: SKIP $name — real file already at $dest (remove it to enable)" >&2
    continue
  fi

  temp="$(mktemp "$git_hooks/.${name}.XXXXXX")"
  cat > "$temp" <<'HOOK'
#!/bin/sh
# tuic-managed-hook
repo_root="$(git rev-parse --show-toplevel)" || exit 1
hook="$repo_root/scripts/hooks/$(basename "$0")"
# A checkout without this hook (an older branch) runs none, as Git does.
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
HOOK
  chmod +x "$temp"
  mv -f "$temp" "$dest"
  temp=""
  echo "hooks: installed $name"
done
