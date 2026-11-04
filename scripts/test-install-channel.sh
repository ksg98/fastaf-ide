#!/usr/bin/env bash
# Real plist discovery; fake the network and extraction process boundaries.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.tmp/tuic-tests"
work=$(mktemp -d "$root/.tmp/tuic-tests/install-channel.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
export INSTALL_TEST_WORK="$work" INSTALL_TEST_ROOT="$root"
export TUICOMMANDER_HOME="$work/Applications"
export PATH="$work/bin:$PATH"
installer="$root/website/public/install.sh"
# Ubuntu runs the Darwin installer cases too, but has no Apple PlistBuddy.
# Adapt only that process boundary in a disposable copy; still parse the real
# installed plist, and keep using Apple's binary when it is available.
if [[ ! -x /usr/libexec/PlistBuddy ]]; then
  cat > "$work/bin/PlistBuddy" <<'MOCK'
#!/usr/bin/env python3
import plistlib
import sys

if sys.argv[1:3] != ['-c', 'Print :CFBundleVersion'] or len(sys.argv) != 4:
    raise SystemExit('unexpected PlistBuddy invocation')
with open(sys.argv[3], 'rb') as source:
    print(plistlib.load(source)['CFBundleVersion'])
MOCK
  sed "s|/usr/libexec/PlistBuddy|$work/bin/PlistBuddy|g" "$installer" > "$work/install.sh"
  installer="$work/install.sh"
fi
cat > "$work/bin/uname" <<'MOCK'
#!/bin/sh
printf 'Darwin\n'
MOCK
cat > "$work/bin/curl" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >> "$INSTALL_TEST_WORK/requests"
case "$*" in
  *releases/download/nightly/latest.json*) cat "$INSTALL_TEST_ROOT/src-tauri/test-fixtures/updater/nightly-manifest.json" ;;
  *api.github.com*releases/latest*) cat "$INSTALL_TEST_ROOT/src-tauri/test-fixtures/updater/github-stable-release.json" ;;
  *releases/download/*) printf 'fixture archive\n' ;;
  *) echo "Unexpected network request: $*" >&2; exit 2 ;;
esac
MOCK
# Extraction yields a FastAF.app under -C, marked so a test can tell the
# downloaded bundle from the one already installed.
cat > "$work/bin/tar" <<'MOCK'
#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = "-C" ] && dir=$2; shift; done
mkdir -p "$dir/FastAF.app/Contents"
echo downloaded > "$dir/FastAF.app/Contents/marker"
MOCK
# Signature boundary. INSTALL_TEST_SIGNATURE picks what the download carries:
# fastaf (default), unsigned, adhoc or other-team.
cat > "$work/bin/codesign" <<'MOCK'
#!/bin/sh
case "$1" in
  --verify)
    [ "${INSTALL_TEST_SIGNATURE:-fastaf}" = unsigned ] && { echo 'code object is not signed at all' >&2; exit 1; }
    exit 0 ;;
  -dv)
    case "${INSTALL_TEST_SIGNATURE:-fastaf}" in
      adhoc) echo 'Signature=adhoc' >&2; echo 'TeamIdentifier=not set' >&2 ;;
      other-team) echo 'Authority=Developer ID Application: Someone Else (ABCDE12345)' >&2; echo 'TeamIdentifier=ABCDE12345' >&2 ;;
      *) echo 'Authority=Developer ID Application: Karamjeet Gulati (NH9933XQGX)' >&2; echo 'TeamIdentifier=NH9933XQGX' >&2 ;;
    esac
    exit 0 ;;
esac
echo "unexpected codesign $*" >&2; exit 2
MOCK
# The final rename of the swap fails on request (INSTALL_TEST_FAIL_SWAP), so a
# test can prove the installed app survives it. Every other mv is the real one.
real_mv="$(command -v mv)"
cat > "$work/bin/mv" <<MOCK
#!/bin/sh
for last; do :; done
if [ -n "\${INSTALL_TEST_FAIL_SWAP:-}" ] && [ "\${1##*/}" = ".FastAF.app.incoming" ] && [ "\${last##*/}" = "FastAF.app" ]; then
  echo "mv: simulated failure" >&2
  exit 1
fi
exec "$real_mv" "\$@"
MOCK
chmod +x "$work/bin/"*
# `set -e` ignores a negated command, so a negated grep never failed a test;
# assert absence explicitly instead.
absent() {
  if grep -q -- "$1" "$2"; then echo "unexpected '$1' in $2" >&2; exit 1; fi
}
no_staging_left() {
  if [ -e "$1/.FastAF.app.incoming" ]; then echo "staged bundle left in $1" >&2; exit 1; fi
}
installed() {
  mkdir -p "$TUICOMMANDER_HOME/FastAF.app/Contents"
  python3 - "$TUICOMMANDER_HOME/FastAF.app/Contents/Info.plist" "$1" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as out:
    plistlib.dump({'CFBundleVersion': sys.argv[2]}, out)
PY
}
run() {
  : > "$work/requests"
  local rc=0
  sh "$installer" "$@" > "$work/output" 2>&1 || rc=$?
  if [[ $rc != 0 ]]; then cat "$work/output" >&2; echo "installer exited $rc" >&2; return "$rc"; fi
}
# Catches: an installed beta reaching for the beta feed FastAF does not publish.
installed 2.0.0-beta.1
run
grep -q '/releases/download/nightly/latest.json' "$work/requests"
grep -q '/releases/download/nightly/FastAF_aarch64.app.tar.gz' "$work/requests"
absent '/releases/download/beta/' "$work/requests"
absent 'releases/latest' "$work/requests"
# Catches: stable/no-version downloads have a duplicate v in their release tag.
rm -rf "$TUICOMMANDER_HOME"
mkdir -p "$TUICOMMANDER_HOME/FastAF.app"
run
grep -q '/releases/download/v1.7.6/FastAF_aarch64.app.tar.gz' "$work/requests"
absent '/releases/download/vv' "$work/requests"
# Catches: explicit versions lose their v, or add one twice.
for version in 1.7.6 v1.7.6; do
  run "$version"
  grep -q '/releases/download/v1.7.6/FastAF_aarch64.app.tar.gz' "$work/requests"
  absent 'releases/latest' "$work/requests"
done
# Catches: a stable installation cannot update because nightly detection exits 1.
installed 1.7.4
run
grep -q '/releases/download/v1.7.6/FastAF_aarch64.app.tar.gz' "$work/requests"
# Catches: auto-detecting beta accidentally replaces the existing nightly path.
installed 1.7.0-nightly.20261010.t0000
run
grep -q '/releases/download/nightly/latest.json' "$work/requests"
grep -q '/releases/download/nightly/FastAF_aarch64.app.tar.gz' "$work/requests"
# Catches: selecting beta explicitly being treated as a literal version, or as a feed FastAF lacks.
installed 1.7.4
run beta
grep -q '/releases/download/nightly/FastAF_aarch64.app.tar.gz' "$work/requests"
absent '/releases/download/beta/' "$work/requests"
absent '/releases/download/vbeta/' "$work/requests"

# --- Signature gate: website/public/install.sh -------------------------------
refused() {
  : > "$work/requests"
  if sh "$installer" > "$work/output" 2>&1; then
    cat "$work/output" >&2; echo "installer should have refused the download" >&2; return 1
  fi
}
# Catches: a verified download not reaching the install dir.
installed 1.7.4
run
grep -qx downloaded "$TUICOMMANDER_HOME/FastAF.app/Contents/marker"
no_staging_left "$TUICOMMANDER_HOME"
# Catches: an unsigned, ad-hoc or foreign bundle replacing the installed app.
for signature in unsigned adhoc other-team; do
  installed 1.7.4
  rm -f "$TUICOMMANDER_HOME/FastAF.app/Contents/marker"
  INSTALL_TEST_SIGNATURE=$signature refused
  grep -q 'Nothing was installed' "$work/output"
  [ -f "$TUICOMMANDER_HOME/FastAF.app/Contents/Info.plist" ]
  [ ! -e "$TUICOMMANDER_HOME/FastAF.app/Contents/marker" ]
  no_staging_left "$TUICOMMANDER_HOME"
done
# Catches: a failed final rename leaving no app at all, because the installed
# one was deleted before the new one was in place.
installed 1.7.4
INSTALL_TEST_FAIL_SWAP=1 refused
grep -q 'previous version was restored' "$work/output"
[ -f "$TUICOMMANDER_HOME/FastAF.app/Contents/Info.plist" ]
[ ! -e "$TUICOMMANDER_HOME/FastAF.app/Contents/marker" ]
no_staging_left "$TUICOMMANDER_HOME"
[ ! -e "$TUICOMMANDER_HOME/.FastAF.app.previous" ]
grep -q 'failed signature verification' <(INSTALL_TEST_SIGNATURE=unsigned sh "$installer" 2>&1 || true)
grep -q 'not signed with a Developer ID' <(INSTALL_TEST_SIGNATURE=adhoc sh "$installer" 2>&1 || true)
grep -q 'another team' <(INSTALL_TEST_SIGNATURE=other-team sh "$installer" 2>&1 || true)

# --- Signature gate: scripts/install.sh (the .dmg installer) -----------------
# Its own process boundaries: the GitHub API, the .dmg, hdiutil, ditto, ps
# (no running app) and a BSD-style `mktemp -d -t`.
dmgbin="$work/dmgbin"
mkdir -p "$dmgbin" "$work/dmgtmp"
cat > "$dmgbin/uname" <<'MOCK'
#!/bin/sh
case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac
MOCK
cat > "$dmgbin/curl" <<'MOCK'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out=$2; shift; done
if [ -n "$out" ]; then printf 'DMG' > "$out"; exit 0; fi
echo '{"tag_name": "v9.9.9", "assets": [{"browser_download_url": "https://example.invalid/FastAF_9.9.9_aarch64.dmg"}]}'
MOCK
cat > "$dmgbin/hdiutil" <<'MOCK'
#!/bin/sh
[ "$1" = attach ] || exit 0
while [ $# -gt 0 ]; do [ "$1" = "-mountpoint" ] && mount=$2; shift; done
mkdir -p "$mount/FastAF.app/Contents"
echo downloaded > "$mount/FastAF.app/Contents/marker"
MOCK
cat > "$dmgbin/ditto" <<'MOCK'
#!/bin/sh
cp -R "$1" "$2"
MOCK
cat > "$dmgbin/ps" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$dmgbin/mktemp" <<'MOCK'
#!/bin/sh
dir="$INSTALL_TEST_WORK/dmgtmp/run$$"
mkdir -p "$dir" && printf '%s\n' "$dir"
MOCK
chmod +x "$dmgbin/"*
dmg_install() {
  PATH="$dmgbin:$PATH" bash "$root/scripts/install.sh" --to "$work/dmg-apps" --force > "$work/output" 2>&1
}
# Catches: a verified .dmg not reaching the install dir.
rm -rf "$work/dmg-apps"
dmg_install || { cat "$work/output" >&2; exit 1; }
grep -qx downloaded "$work/dmg-apps/FastAF.app/Contents/marker"
# Catches: the .dmg installer swapping in a bundle it never verified.
for signature in unsigned adhoc other-team; do
  rm -rf "$work/dmg-apps"
  mkdir -p "$work/dmg-apps/FastAF.app/Contents"
  echo previous > "$work/dmg-apps/FastAF.app/Contents/marker"
  if INSTALL_TEST_SIGNATURE=$signature dmg_install; then
    cat "$work/output" >&2; echo "scripts/install.sh accepted a $signature bundle" >&2; exit 1
  fi
  grep -q 'Nothing was installed' "$work/output"
  grep -qx previous "$work/dmg-apps/FastAF.app/Contents/marker"
  [ ! -e "$work/dmg-apps/.FastAF.app.incoming" ]
done
# Catches: the .dmg installer deleting the installed app before the new one is in.
rm -rf "$work/dmg-apps"
mkdir -p "$work/dmg-apps/FastAF.app/Contents"
echo previous > "$work/dmg-apps/FastAF.app/Contents/marker"
if INSTALL_TEST_FAIL_SWAP=1 dmg_install; then
  cat "$work/output" >&2; echo "scripts/install.sh reported success with a failed swap" >&2; exit 1
fi
grep -q 'previous version was restored' "$work/output" || { cat "$work/output" >&2; exit 1; }
grep -qx previous "$work/dmg-apps/FastAF.app/Contents/marker"
[ ! -e "$work/dmg-apps/.FastAF.app.incoming" ]
for left in "$work/dmg-apps"/FastAF.app.bak-*; do
  [ -e "$left" ] && { echo "backup left behind: $left" >&2; exit 1; }
done
echo 'install-channel ok (8 cases + 8 signature cases + 2 swap cases)'
