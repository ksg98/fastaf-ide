#!/usr/bin/env bash
# Build the mdBook docs and generate the Pagefind search index.
#
# Single source of truth for the docs build — used by `make docs` and by the
# "Build docs" step in .github/workflows/website.yml, so local previews and the
# deployed site are byte-for-byte the same pipeline.
#
# Usage: scripts/build-docs.sh [dest-dir]      (default: docs/book)
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

DEST="${1:-$REPO_ROOT/docs/book}"
case "$DEST" in
    /*) ;;
    *) DEST="$REPO_ROOT/$DEST" ;;
esac

PAGEFIND_VERSION="1"

command -v mdbook >/dev/null 2>&1 || {
    echo "error: mdbook not found — install it with 'cargo install mdbook' or 'brew install mdbook'" >&2
    exit 1
}

echo "==> mdbook build -> $DEST"
mdbook build docs --dest-dir "$DEST"

# Keep non-chapter pages out of the search index:
#   print.html  duplicates the entire book (would win every query)
#   toc.html    is the sidebar fragment, a bare list of links
#   404.html    is a stub
#   examples/sdk-test.html  is an SDK demo harness, not prose
# Pagefind takes a single include-glob and its glob syntax has no negation, so we
# move these aside for the duration of the indexing run.
NOINDEX=(print.html toc.html 404.html examples/sdk-test.html)
restore() {
    for page in "${NOINDEX[@]}"; do
        [ -f "$DEST/$page.noindex" ] && mv "$DEST/$page.noindex" "$DEST/$page"
    done
    return 0
}
trap restore EXIT

for page in "${NOINDEX[@]}"; do
    [ -f "$DEST/$page" ] && mv "$DEST/$page" "$DEST/$page.noindex"
done

# Two rewrites of the generated HTML, both required for usable search results:
#   1. data-pagefind-body on <main> scopes the index to the chapter text —
#      without it Pagefind swallows the sidebar TOC and the keyboard-help overlay.
#   2. mdBook renders the book name in the menu bar as <h1 class="menu-title">.
#      Pagefind titles a result from the first <h1> on the page, so every result
#      came back named "FastAF". Demoting it to a <div> (styling is by
#      class, not tag) fixes that and leaves one real <h1> per page.
# `perl -i` rather than `sed -i` so it behaves the same on macOS and on Linux CI.
echo "==> prepare HTML for indexing"
find "$DEST" -name '*.html' -exec perl -0pi \
    -e 's|<main>|<main data-pagefind-body>|;' \
    -e 's|<h1 class="menu-title">(.*?)</h1>|<div class="menu-title">$1</div>|s;' {} +

echo "==> pagefind index"
npx -y "pagefind@$PAGEFIND_VERSION" \
    --site "$DEST" \
    --exclude-selectors ".nav-wrapper,#tuic-search,#tuic-hero-search" \
    --include-characters="-_./" \
    --quiet

restore
trap - EXIT

echo "==> docs ready: $DEST"
