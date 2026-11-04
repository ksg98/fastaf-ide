#!/bin/sh
# vim: set expandtab ts=2 sw=2 :
set -e

REPO="${TUICOMMANDER_REPO:-ksg98/fastaf-ide}"
API_URL="https://api.github.com/repos/$REPO"
RELEASE_URL="$API_URL/releases"

OSX_HOME="${TUICOMMANDER_HOME:-/Applications}"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    echo "usage: $0 [version]"
    exit 1
fi
if [ $# -eq 1 ]; then
    WANTED_VER="${1#v}"
    shift $((OPTIND - 1))
fi

# FastAF's Developer ID team. A bundle that is unsigned, ad-hoc signed, signed
# by anyone else, or altered after signing never replaces the installed app:
# macOS ties every permission the user granted to this signature, and a
# download that only claims to be FastAF must not run.
TEAM_ID="NH9933XQGX"

# verify_signature <app>: succeed only for an intact Developer ID signature
# from FastAF's team; otherwise say why and fail.
verify_signature() {
  if ! command -v codesign > /dev/null 2>&1; then
    echo "Error: codesign is required to verify the download. Nothing was installed."
    return 1
  fi
  if ! codesign --verify --deep --strict "$1" 2> /dev/null; then
    echo "Error: the downloaded FastAF.app failed signature verification (unsigned or altered). Nothing was installed."
    return 1
  fi
  SIGNATURE=$(codesign -dv --verbose=2 "$1" 2>&1) || {
    echo "Error: could not read the signature of the downloaded FastAF.app. Nothing was installed."
    return 1
  }
  if ! printf '%s\n' "$SIGNATURE" | grep -q '^Authority=Developer ID Application: '; then
    echo "Error: the downloaded FastAF.app is not signed with a Developer ID certificate. Nothing was installed."
    return 1
  fi
  if ! printf '%s\n' "$SIGNATURE" | grep -qx "TeamIdentifier=$TEAM_ID"; then
    echo "Error: the downloaded FastAF.app is signed by another team, not FastAF's ($TEAM_ID). Nothing was installed."
    return 1
  fi
}

get_download_url() {
  curl -s "$RELEASE_URL/latest" \
    | grep -o "\"browser_download_url\": *\"[^\"]*${1}\"" \
    | head -1 \
    | grep -o 'https://[^"]*'
}

install_macos() (
  APP_HOME=
  APP_VER=

  if [ -d "$OSX_HOME/FastAF.app" ]; then
    APP_HOME="$OSX_HOME/FastAF.app"
  else
    # might not be in the usual place, but if the user has set up the fastaf CLI we can find it from that
    TUIC_BIN=$(command -v fastaf || true)
    if [ -n "$TUIC_BIN" ] && [ -L "$TUIC_BIN" ]; then
      TUIC=$(readlink "$TUIC_BIN")
      APP_HOME="${TUIC%/Contents/MacOS/fastaf}"
      OSX_HOME="${APP_HOME%/FastAF.app}"
    fi
  fi

  if [ -n "$APP_HOME" ]; then
    # verify it actually looks like the app
    if [ -f "$APP_HOME/Contents/Info.plist" ]; then
      APP_VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_HOME/Contents/Info.plist")
      if [ -n "$APP_VER" ]; then
        # 1.3.0-nightly.20260603.t2024
        # 1.3.0
        echo "Found ${APP_VER} currently installed"
      fi
    fi
  fi

  if [ -n "$APP_VER" ] && [ -z "$WANTED_VER" ]; then
    # An installed prerelease stays on its channel when no version is given.
    # FastAF publishes no beta feed: an installed beta follows nightly, as the
    # app's own update channel does.
    case "$APP_VER" in
      *-nightly*|*-beta.*) WANTED_VER="nightly" ;;
    esac
  fi
  if [ "$WANTED_VER" = "beta" ]; then WANTED_VER="nightly"; fi

  # get the latest version from GitHub
  LATEST_VER="unknown"
  if [ "$WANTED_VER" = "nightly" ]; then
    CHANNEL="nightly"
    # fetch the latest json for nightly so we can find the version string there
    # "version": "1.3.0-nightly.20260603.t2025",
    LATEST_VER=$(curl -sS --fail-with-body -L \
        "https://github.com/${REPO}/releases/download/${CHANNEL}/latest.json" \
        | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^" ]*\)".*/\1/p')
    echo "Found $LATEST_VER as latest $CHANNEL"

    # nightly ver numbers can be slightly different between the actual app version found in Info.plist and the version found in latest.json
    # so we strip off the tail end of the version strings -- as nightly is supposed to be once a day, we should be ok
    LATEST_VER="${LATEST_VER%.t*}"
    APP_VER="${APP_VER%.t*}"
  elif [ -n "$WANTED_VER" ]; then
    # no need to check GitHub, the user specified the version they want
    LATEST_VER="${WANTED_VER#v}"
    WANTED_VER="v${LATEST_VER}"
  else
    # v1.3.0 -> 1.3.0
    LATEST_VER=$(curl -sS --fail-with-body -L \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$RELEASE_URL/latest" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^" ]*\)".*/\1/p')
    echo "Found ${LATEST_VER} as latest release version"
    WANTED_VER="v${LATEST_VER}"
  fi

  if [ -z "$LATEST_VER" ]; then
    echo "Unable to determine latest version from GitHub"
    exit 1
  fi

  if [ "$LATEST_VER" = "$APP_VER" ]; then
    echo "No need to update"
    exit 0
  fi

  ASSET="FastAF_aarch64.app.tar.gz"
  URL="https://github.com/$REPO/releases/download/$WANTED_VER/$ASSET"
  echo "Downloading and installing version ${LATEST_VER}"
  # Extract into a private scratch dir and verify there: the installed app is
  # only replaced by a bundle that passed `verify_signature`.
  STAGE_DIR=$(make_private_tmpdir)
  trap 'rm -rf "$STAGE_DIR"' EXIT
  curl -LSs "$URL" \
    | tar xz -C "$STAGE_DIR"
  NEW_APP="$STAGE_DIR/FastAF.app"
  if [ ! -d "$NEW_APP" ]; then
    echo "Error: the download did not contain FastAF.app. Nothing was installed."
    exit 1
  fi
  verify_signature "$NEW_APP" || exit 1
  mkdir -p "$OSX_HOME"
  TARGET="$OSX_HOME/FastAF.app"
  STAGED="$OSX_HOME/.FastAF.app.incoming"
  PREVIOUS="$OSX_HOME/.FastAF.app.previous"
  rm -rf "$STAGED" "$PREVIOUS"
  # Staged on the target's volume, so the swap below is two renames. The
  # installed app is only deleted once the new one is in place: a failure at
  # any step leaves a working FastAF.app behind.
  if ! mv "$NEW_APP" "$STAGED"; then
    rm -rf "$STAGED"
    echo "Error: cannot write to $OSX_HOME. Nothing was installed."
    exit 1
  fi
  if [ -d "$TARGET" ] && ! mv "$TARGET" "$PREVIOUS"; then
    rm -rf "$STAGED"
    echo "Error: cannot move the installed FastAF.app aside. Nothing was installed."
    exit 1
  fi
  if ! mv "$STAGED" "$TARGET"; then
    if [ -d "$PREVIOUS" ]; then mv "$PREVIOUS" "$TARGET"; fi
    rm -rf "$STAGED"
    echo "Error: could not move the new FastAF.app into place. The previous version was restored."
    exit 1
  fi
  rm -rf "$PREVIOUS"
  echo "Installed to ${TARGET}"
)

# A fresh 0700 directory under the caller's temp dir ($TMPDIR, else /tmp).
# The package keeps its extension inside it: a suffix after the X's of a
# mktemp template is a GNU extension, and a private dir also stops another
# local user from swapping the file before `sudo dpkg/rpm` installs it.
make_private_tmpdir() {
  mktemp -d "${TMPDIR:-/tmp}/fastaf-XXXXXX"
}

install_linux() {
  if command -v dpkg > /dev/null 2>&1; then
    echo "Detected dpkg — installing .deb package..."
    URL=$(get_download_url 'amd64\.deb')
    if [ -z "$URL" ]; then echo "Error: .deb asset not found in latest release"; exit 1; fi
    TMP_DIR=$(make_private_tmpdir)
    # `set -e` aborts on a failed download or install; still drop the scratch dir.
    trap 'rm -rf "$TMP_DIR"' EXIT
    TMP="$TMP_DIR/fastaf.deb"
    curl -fsSL "$URL" -o "$TMP"
    sudo dpkg -i "$TMP"
    rm -rf "$TMP_DIR"
  elif command -v rpm > /dev/null 2>&1; then
    echo "Detected rpm — installing .rpm package..."
    URL=$(get_download_url 'x86_64\.rpm')
    if [ -z "$URL" ]; then echo "Error: .rpm asset not found in latest release"; exit 1; fi
    TMP_DIR=$(make_private_tmpdir)
    # `set -e` aborts on a failed download or install; still drop the scratch dir.
    trap 'rm -rf "$TMP_DIR"' EXIT
    TMP="$TMP_DIR/fastaf.rpm"
    curl -fsSL "$URL" -o "$TMP"
    sudo rpm -i "$TMP"
    rm -rf "$TMP_DIR"
  else
    echo "No dpkg or rpm found — installing AppImage..."
    URL=$(get_download_url 'amd64\.AppImage')
    if [ -z "$URL" ]; then echo "Error: AppImage asset not found in latest release"; exit 1; fi
    DEST="${HOME}/.local/bin/FastAF.AppImage"
    mkdir -p "$(dirname "$DEST")"
    curl -fsSL "$URL" -o "$DEST"
    chmod +x "$DEST"
    echo "Installed to $DEST"
    echo "Make sure ~/.local/bin is in your PATH"
    return
  fi
  echo "FastAF installed successfully!"
}

OS=$(uname -s)
echo "Installing FastAF for $OS..."

case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *)      echo "Unsupported OS: $OS. Download manually from https://github.com/$REPO/releases"; exit 1 ;;
esac

exit 0
