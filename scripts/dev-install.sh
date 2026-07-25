#!/usr/bin/env bash
# dev-install.sh — Symlink plugins from this repo into the FastAF plugins directory.
#
# Usage:
#   ./scripts/dev-install.sh              # symlink all plugins
#   ./scripts/dev-install.sh mdkb-dashboard wiz-stories  # symlink specific plugins
#   ./scripts/dev-install.sh --clean      # remove all symlinks
#
# Plugins are symlinked, so edits in this repo are immediately picked up
# by FastAF's hot-reload system.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS_SRC="$REPO_ROOT/plugins"

# Determine plugin install directories per platform. Debug and release builds use
# different bundle ids; install into both so `make dev` sees symlinks too.
PLUGINS_DIRS=()
case "$(uname)" in
  Darwin)
    PLUGINS_DIRS=(
      "$HOME/Library/Application Support/tuicommander/plugins"
      "$HOME/Library/Application Support/com.tuic.commander/plugins"
    )
    ;;
  Linux)
    PLUGINS_DIRS=(
      "${XDG_CONFIG_HOME:-$HOME/.config}/tuicommander/plugins"
      "${XDG_CONFIG_HOME:-$HOME/.config}/com.tuic.commander/plugins"
    )
    ;;
  MINGW*|MSYS*|CYGWIN*)
    PLUGINS_DIRS=(
      "$APPDATA/com.fastaf.ide/plugins"
      "$APPDATA/com.tuic.commander/plugins"
    )
    ;;
  *)
    echo "Unsupported platform: $(uname)" >&2
    exit 1
    ;;
esac

for plugins_dir in "${PLUGINS_DIRS[@]}"; do
  mkdir -p "$plugins_dir"
done

# --clean: remove symlinks we created
if [[ "${1:-}" == "--clean" ]]; then
  shopt -s nullglob
  for plugins_dir in "${PLUGINS_DIRS[@]}"; do
    for link in "$plugins_dir"/*/; do
      link="${link%/}"
      if [[ -L "$link" ]]; then
        target="$(readlink "$link")"
        if [[ "$target" == "$PLUGINS_SRC"/* ]]; then
          echo "Removing symlink: $(basename "$link") from $plugins_dir"
          rm "$link"
        fi
      fi
    done
  done
  shopt -u nullglob
  echo "Done."
  exit 0
fi

# Collect plugin dirs to install
if [[ $# -gt 0 ]]; then
  PLUGIN_NAMES=("$@")
else
  PLUGIN_NAMES=()
  for dir in "$PLUGINS_SRC"/*/; do
    dir="${dir%/}"
    name="$(basename "$dir")"
    if [[ -f "$dir/manifest.json" ]]; then
      PLUGIN_NAMES+=("$name")
    fi
  done
fi

if [[ ${#PLUGIN_NAMES[@]} -eq 0 ]]; then
  echo "No plugins found to install." >&2
  exit 1
fi

for name in "${PLUGIN_NAMES[@]}"; do
  src="$PLUGINS_SRC/$name"

  if [[ ! -d "$src" ]]; then
    echo "SKIP: $name — directory not found at $src" >&2
    continue
  fi

  if [[ ! -f "$src/manifest.json" ]]; then
    echo "SKIP: $name — no manifest.json" >&2
    continue
  fi

  for plugins_dir in "${PLUGINS_DIRS[@]}"; do
    dest="$plugins_dir/$name"

    if [[ -L "$dest" ]]; then
      echo "UPDATE: $name (replacing existing symlink in $plugins_dir)"
      rm "$dest"
    elif [[ -d "$dest" ]]; then
      echo "SKIP: $name — real directory already exists at $dest (remove it first)" >&2
      continue
    fi

    ln -s "$src" "$dest"
    echo "LINKED: $name → $dest"
  done
done

echo ""
echo "Restart FastAF or save a plugin file to trigger hot-reload."
