#!/usr/bin/env bash
# install.sh — download, install and de-quarantine FastAF on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/ksg98/fastaf-ide/main/scripts/install.sh | bash
#
# Options (pass with `| bash -s -- <opts>` when piping):
#   --version vX.Y.Z   install a specific release (default: latest)
#   --nightly          install the rolling `nightly` pre-release
#   --to DIR           install into DIR instead of /Applications
#   --force            reinstall even when the installed version already matches
#   --quit             ask a running FastAF to quit, then wait for it
#   --keep-backup      keep the replaced .app as <name>.bak-<version>-<date>
#
# FastAF is not code-signed or notarized, so macOS quarantines anything
# downloaded from a release and reports it as "damaged" on first launch. This
# script clears that attribute on every install — which is exactly what makes it
# worth running for updates too, not only the first time.

set -euo pipefail

REPO="ksg98/fastaf-ide"
APP_NAME="FastAF.app"
INSTALL_DIR="/Applications"
CHANNEL="latest"
VERSION=""
FORCE=0
DO_QUIT=0
KEEP_BACKUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --nightly) CHANNEL="nightly"; shift ;;
    --to) INSTALL_DIR="${2:?--to needs a directory}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --quit) DO_QUIT=1; shift ;;
    --keep-backup) KEEP_BACKUP=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

# ── Preconditions ────────────────────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" ]] || die "this installer is macOS-only. For Linux use the .deb/.rpm/.AppImage, for Windows the .exe: https://github.com/$REPO/releases"

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  die "no macOS build for $ARCH — releases currently ship an aarch64 (Apple Silicon) .dmg only.
     On an Intel Mac, build from source: https://github.com/$REPO#development"
fi

command -v curl >/dev/null || die "curl is required"
command -v hdiutil >/dev/null || die "hdiutil is required"
command -v ditto >/dev/null || die "ditto is required"

# ── Resolve the release and its .dmg ─────────────────────────────────────────
if [[ -n "$VERSION" ]]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
elif [[ "$CHANNEL" == "nightly" ]]; then
  API="https://api.github.com/repos/$REPO/releases/tags/nightly"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

note "Resolving release from $REPO"
# Bash 3.2 (what macOS ships) treats "${arr[@]}" on an empty array as unbound
# under `set -u`, so the token header is passed as a plain string instead.
AUTH_HEADER=""
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
if [[ -n "$AUTH_HEADER" ]]; then
  RELEASE_JSON="$(curl -fsSL -H "$AUTH_HEADER" -H 'Accept: application/vnd.github+json' "$API")" \
    || die "could not reach the GitHub API for ${VERSION:-$CHANNEL}"
else
  RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
    || die "could not reach the GitHub API for ${VERSION:-$CHANNEL} (rate limited? set GITHUB_TOKEN)"
fi

TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
DMG_URL="$(printf '%s' "$RELEASE_JSON" \
  | tr ',' '\n' \
  | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*aarch64\.dmg\)".*/\1/p' \
  | head -1)"

[[ -n "$DMG_URL" ]] || die "release ${TAG:-$CHANNEL} has no aarch64 .dmg asset.
     Assets are listed at https://github.com/$REPO/releases"

note "Release $TAG"

# ── Skip a no-op update ──────────────────────────────────────────────────────
TARGET_APP="$INSTALL_DIR/$APP_NAME"
INSTALLED=""
if [[ -d "$TARGET_APP" ]]; then
  INSTALLED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$TARGET_APP/Contents/Info.plist" 2>/dev/null || true)"
fi
if [[ -n "$INSTALLED" && "$TAG" == "v$INSTALLED" && $FORCE -eq 0 ]]; then
  note "FastAF $INSTALLED is already installed — clearing quarantine and exiting."
  xattr -cr "$TARGET_APP" 2>/dev/null || true
  note "Nothing else to do. Re-run with --force to reinstall."
  exit 0
fi
[[ -n "$INSTALLED" ]] && note "Installed: $INSTALLED  →  installing: ${TAG#v}"

# ── Refuse to clobber a running app ──────────────────────────────────────────
# Replacing a live bundle corrupts the running process's own code pages; every
# open PTY and agent session in it dies with it.
running_pid() { pgrep -f "$INSTALL_DIR/$APP_NAME/Contents/MacOS/" 2>/dev/null | head -1; }
if [[ -n "$(running_pid)" ]]; then
  if [[ $DO_QUIT -eq 1 ]]; then
    note "Asking FastAF to quit…"
    osascript -e 'tell application "FastAF" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do [[ -z "$(running_pid)" ]] && break; sleep 1; done
    [[ -z "$(running_pid)" ]] || die "FastAF is still running — quit it by hand and re-run."
  else
    die "FastAF is running. Quit it first (its terminal sessions will end), then re-run.
     Or re-run with --quit to have this script ask it to quit."
  fi
fi

# ── Download ─────────────────────────────────────────────────────────────────
TMP="$(mktemp -d -t fastaf-install)"
MOUNT=""
cleanup() {
  [[ -n "$MOUNT" && -d "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

DMG="$TMP/FastAF.dmg"
note "Downloading $(basename "$DMG_URL")"
curl -fL --progress-bar "$DMG_URL" -o "$DMG" || die "download failed"

# ── Mount, stage, swap ───────────────────────────────────────────────────────
MOUNT="$TMP/mnt"
mkdir -p "$MOUNT"
note "Mounting disk image"
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MOUNT" \
  || die "could not mount the disk image"

SRC_APP="$MOUNT/$APP_NAME"
[[ -d "$SRC_APP" ]] || die "$APP_NAME not found inside the disk image"

mkdir -p "$INSTALL_DIR" 2>/dev/null || true
[[ -d "$INSTALL_DIR" ]] || die "$INSTALL_DIR does not exist and could not be created"

STAGED="$INSTALL_DIR/.$APP_NAME.incoming"
rm -rf "$STAGED"
note "Copying into $INSTALL_DIR"
if ! ditto "$SRC_APP" "$STAGED" 2>/dev/null; then
  rm -rf "$STAGED"
  die "cannot write to $INSTALL_DIR — re-run with sudo, or use --to ~/Applications"
fi

# Clear quarantine on the staged copy BEFORE it becomes the live bundle, so the
# app is never briefly installed-but-quarantined.
note "Clearing the quarantine attribute (xattr -cr)"
xattr -cr "$STAGED" || true

# Gatekeeper also rejects a bundle whose signature is missing or broken. Release
# builds are ad-hoc signed; re-sign only if verification actually fails, so a
# good signature is never replaced with a weaker one.
if ! codesign --verify --no-strict "$STAGED" >/dev/null 2>&1; then
  note "Signature did not verify — applying an ad-hoc signature"
  codesign --force --deep --sign - "$STAGED" >/dev/null 2>&1 \
    || note "ad-hoc signing failed; if the app will not open, run: codesign --force --deep --sign - $TARGET_APP"
fi

if [[ -d "$TARGET_APP" ]]; then
  BACKUP="$INSTALL_DIR/$APP_NAME.bak-${INSTALLED:-prev}-$(date +%Y%m%d%H%M%S)"
  mv "$TARGET_APP" "$BACKUP"
  if [[ $KEEP_BACKUP -eq 1 ]]; then
    note "Previous version kept at $BACKUP"
  else
    rm -rf "$BACKUP" || true
  fi
fi
mv "$STAGED" "$TARGET_APP"

# Belt and braces: the move itself can re-tag the bundle on some macOS versions.
xattr -cr "$TARGET_APP" 2>/dev/null || true

note "Installed FastAF ${TAG#v} to $TARGET_APP"
note "Launch it with:  open -a FastAF"
