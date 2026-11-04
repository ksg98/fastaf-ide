# Updater fixtures

Recorded read-only from sstraus/tuicommander on 2026-10-12:

- `gh api repos/sstraus/tuicommander/releases/latest --jq '{tag_name,prerelease,draft,html_url,assets:[.assets[]|{name,browser_download_url}]}'`
- `gh api repos/sstraus/tuicommander/releases/tags/nightly` with the same projection.
- `curl -fsSL https://github.com/sstraus/tuicommander/releases/latest/download/latest.json`
- `curl -fsSL https://github.com/sstraus/tuicommander/releases/download/nightly/latest.json`

The repo has no published versioned beta yet. Tests that need beta metadata change only the recorded manifest's version; this is a synthetic scenario using the observed tauri-action schema, not a captured beta response. The publisher copies the original manifest bytes, signatures and immutable asset URLs without rewriting them. No live release was created or changed during verification.
