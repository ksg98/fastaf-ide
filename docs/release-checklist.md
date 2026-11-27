# Release & Tag Checklist

When Boss asks to tag a release:

1. **Update version**: run `make bump V=x.y.z` (updates all manifests, CHANGELOG, SPEC.md, and generates AI release notes with contributor extraction via `scripts/generate-release-notes.sh`)
2. **Review release notes** — the script shows AI-generated notes for approval (Y/edit/regenerate/quit). Ensure `### Community` section in CHANGELOG lists all external contributors with PR links
3. **Commit** with message `chore: bump version to vX.Y.Z`
4. **Tag** with `git tag vX.Y.Z`
5. **Publish the tag** — push the approved commit and tag through the normal release procedure. The `Release` workflow builds all platforms and the remote daemon, uploads signed installers and `latest.json`, then publishes the draft with changelog notes. Wait for its successful conclusion and verify the assets; do not create a second release with `gh release create`
6. **Milestone** — close the matching milestone if one exists, create the next one

## Prereleases

Use `make bump V=2.0.0-beta.1` and tag `v2.0.0-beta.1`. `scripts/release-flags.sh` makes `release.yml` publish any version with a `-` suffix as a prerelease that is never "latest". The stable updater endpoint (`releases/latest/download/latest.json`) and the install scripts read "latest", so stable users stay on stable.

FastAF publishes **no rolling beta feed**: `release.yml` has no step that copies a prerelease's `latest.json` to a `beta` release, and the app offers only Stable and Nightly in **Settings → General → Update Channel** (`updater.rs` knows only `nightly`). A saved `beta` channel loads as Nightly. A prerelease therefore reaches testers only as its versioned release page: install it from there, or pass its version to the installer. Nightly behavior is unchanged.

The macOS terminal installer (`website/public/install.sh`) preserves an installed Nightly channel when no version is given. Use `install.sh nightly` to select it explicitly, or pass a version with or without a single `v` prefix to pin it. A default stable install resolves GitHub's latest stable tag. FastAF publishes no beta feed, so `install.sh beta` and an installed beta both follow Nightly.

Both macOS installers verify before they install. `website/public/install.sh` unpacks `FastAF_aarch64.app.tar.gz` into a private temp dir; `scripts/install.sh` downloads the `.dmg` into one, mounts it read-only and copies the app to a hidden staging folder beside the target. Each runs `codesign --verify --deep --strict` and requires `Authority=Developer ID Application:` with `TeamIdentifier=NH9933XQGX`, then swaps by renames on the same volume into `/Applications` (or `TUICOMMANDER_HOME` / `--to DIR`): the installed app is moved aside first (`.FastAF.app.previous` for the website script; `FastAF.app.bak-<version>-<date>` for `scripts/install.sh`, kept with `--keep-backup`), the new one is moved in, and the old one is deleted only after that. A failed check prints "Nothing was installed." and leaves the installed app alone; a failed final move puts the previous app back and prints "The previous version was restored." `scripts/install.sh` reads the installed version only when `Contents/Info.plist` exists, so a missing plist no longer names the backup with PlistBuddy's error text. **A release whose macOS bundle is not Developer ID signed by that team cannot be installed from the shell**, so confirm the signing step before publishing.

## GitHub Issue Management

- **Labels**: Use `type:`, `P0-P3:`, `area:`, `effort:` prefixes. Apply `needs triage` to new issues.
- **Milestones**: Assign issues to version milestones (v0.4.0, v1.0.0, etc.)
- **Issue templates**: Bug reports and feature requests use `.github/ISSUE_TEMPLATE/*.yml` forms
- **Token for project ops**: Use `GH_TOKEN=$GH_STRAUS gh ...` when commands need the `project` scope (the default `gh auth` token only has `repo` + `workflow`)

## What the Release workflow gates on

A release stays a draft, and nothing reaches the updater, unless every one of
these passes (see [the CI guide](guides/ci.md)):

- **macOS:** the bundle is Developer ID signed, notarized and stapled
  (`require: 'true'` on the signing step, then `codesign` and `stapler` checks).
  The macOS leg may run for 120 minutes; Linux and Windows for 90.
- **Linux and Windows:** built with `--features vulkan` for GPU dictation. The
  x64 whisper.cpp libraries must contain no AVX-512 code
  (`scripts/check-ggml-x86-baseline.sh`).
- **Linux:** the AppImage carries `libvulkan.so.1`, and the `.deb`, `.rpm` and
  AppImage hold x64 builds of `FastAF`, `fastaf-cli` and `tuic-bridge`
  (`scripts/check-linux-desktop-packages.sh`). The job uploads
  `SHA256SUMS-Linux-x64.txt` to the release.
- **Updater feed:** `latest.json` lists macOS ARM64, Windows x64 and Linux x64
  with every format-specific entry (`scripts/check-linux-updater.py`).

FastAF publishes no Linux ARM64 desktop build; the remote daemon does ship for
Linux ARM64. `make nightly` pushes `main`, which starts the Nightly workflow.
Run a nightly and confirm all three desktop legs before tagging when the build
setup changed since the last release.
