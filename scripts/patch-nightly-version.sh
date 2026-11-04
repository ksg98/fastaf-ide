#!/usr/bin/env bash
# Stamps the checkout with the nightly version. Shared by the desktop legs of
# nightly.yml and by remote-daemon.yml, so a nightly daemon and a nightly desktop
# carry the same version format.
set -euo pipefail

# Append nightly timestamp to current version (strip any existing -nightly suffix first)
VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
VERSION="${VERSION%%-nightly*}"
NIGHTLY="$VERSION-nightly.$(date -u +%Y%m%d).t$(date -u +%H%M)"
echo "Nightly version: $NIGHTLY (from $VERSION)"

# Patch tauri.conf.json: version + add nightly updater endpoint
python3 -c "
import json
c = json.load(open('src-tauri/tauri.conf.json'))
c['version'] = '$NIGHTLY'
nightly_ep = 'https://github.com/ksg98/fastaf-ide/releases/download/nightly/latest.json'
ep = c['plugins']['updater']['endpoints']
if nightly_ep not in ep:
    ep.insert(0, nightly_ep)
json.dump(c, open('src-tauri/tauri.conf.json','w'), indent=2)
print('Patched tauri.conf.json')
"

# Patch Cargo.toml version
sed "s/^version = \"$VERSION\"/version = \"$NIGHTLY\"/" src-tauri/Cargo.toml > tmp.toml && mv tmp.toml src-tauri/Cargo.toml
