// Docs search, backed by Pagefind.
//
// mdBook's built-in elasticlunr search is disabled in book.toml: it shipped a
// single 4.2 MB index downloaded on first search. Pagefind uses a chunked index
// and gives live sub-result suggestions while typing.
//
// Two entry points, one engine:
//   * the magnifier button in the menu bar (where mdBook's used to be), and
//   * the big hero box on the landing page (rendered from index.md).
//
// The Pagefind bundle is generated after `mdbook build` (see scripts/build-docs.sh).
// When it is missing — e.g. a bare `mdbook build docs` — the search UI removes
// itself instead of rendering a dead input.
(function () {
    "use strict";

    // Must be an ABSOLUTE url. Pagefind dynamically imports `<bundlePath>pagefind.js`,
    // and a relative specifier inside a classic script resolves against the script's
    // own url (…/pagefind/pagefind-ui.js), not the page — which yields
    // /pagefind/pagefind/pagefind.js and a search that spins forever.
    var root = typeof path_to_root === "string" && path_to_root ? path_to_root : "./";
    var bundlePath = new URL(root + "pagefind/", document.baseURI).href;

    var menuBar = document.getElementById("mdbook-menu-bar");
    var leftButtons = menuBar && menuBar.querySelector(".left-buttons");
    if (!leftButtons) return;

    // Landing-page hero box, if we are on that page.
    var hero = document.getElementById("tuic-hero-search");

    var MAGNIFIER =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true">' +
        '<path fill="currentColor" d="M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376c-34.4 25.2-76.8 40-122.7 40C93.1 416 0 322.9 0 208S93.1 0 208 0S416 93.1 416 208zM208 352c79.5 0 144-64.5 144-144s-64.5-144-144-144S64 128.5 64 208s64.5 144 144 144z"/>' +
        "</svg>";

    var container = document.createElement("div");
    container.id = "tuic-search";
    container.className = "tuic-search";
    container.innerHTML =
        '<button id="tuic-search-toggle" class="icon-button" type="button" title="Search (`/`)"' +
        ' aria-label="Toggle Searchbar" aria-expanded="false" aria-controls="tuic-search-panel">' +
        '<span class="fa-svg">' +
        MAGNIFIER +
        "</span></button>" +
        '<div id="tuic-search-panel" class="tuic-search__panel" hidden><div id="tuic-search-ui"></div></div>';
    leftButtons.appendChild(container);

    var toggle = container.querySelector("#tuic-search-toggle");
    var panel = container.querySelector("#tuic-search-panel");

    function loadCss() {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = bundlePath + "pagefind-ui.css";
        document.head.appendChild(link);
    }

    function loadScript() {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = bundlePath + "pagefind-ui.js";
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    function barInput() {
        return panel.querySelector(".pagefind-ui__search-input");
    }

    function heroInput() {
        return hero && hero.querySelector(".pagefind-ui__search-input");
    }

    function clearWithin(scope) {
        var clear = scope && scope.querySelector(".pagefind-ui__search-clear");
        if (clear) clear.click();
    }

    function openBar() {
        panel.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        var el = barInput();
        if (el) {
            el.focus();
            el.select();
        }
    }

    function closeBar() {
        clearWithin(panel);
        panel.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
    }

    function bindInteractions() {
        toggle.addEventListener("click", function () {
            if (panel.hidden) openBar();
            else closeBar();
        });

        // Outside click dismisses the floating menu-bar panel. The hero results are
        // inline on the page, so they stay put.
        document.addEventListener("click", function (e) {
            if (!panel.hidden && !container.contains(e.target)) closeBar();
        });

        // `/` and Cmd/Ctrl+K go to the hero box when it is on the page, otherwise
        // they pop the menu-bar one. Escape closes/clears whichever is focused.
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                if (hero && hero.contains(document.activeElement)) {
                    clearWithin(hero);
                    document.activeElement.blur();
                    return;
                }
                if (!panel.hidden) {
                    closeBar();
                    toggle.focus();
                }
                return;
            }

            var typing =
                document.activeElement &&
                /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
            if (typing || e.altKey) return;

            if (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
                e.preventDefault();
                var el = heroInput();
                if (el) {
                    el.focus();
                    el.select();
                } else {
                    openBar();
                }
            }
        });
    }

    function mount(selector, options) {
        var config = {
            element: selector,
            bundlePath: bundlePath,
            showImages: false,
            showSubResults: true,
            pageSize: 8,
            excerptLength: 25,
            autofocus: false,
            translations: {
                placeholder: "Search the docs…",
                zero_results: 'No matches for "[SEARCH_TERM]"',
            },
        };
        Object.keys(options || {}).forEach(function (key) {
            config[key] = options[key];
        });
        new window.PagefindUI(config);
    }

    loadCss();
    loadScript()
        .then(function () {
            mount("#tuic-search-ui");
            if (hero) {
                mount("#tuic-hero-search", {
                    pageSize: 10,
                    translations: {
                        placeholder: "Search the documentation",
                        zero_results: 'No matches for "[SEARCH_TERM]"',
                    },
                });
            }
            bindInteractions();
        })
        .catch(function () {
            container.remove();
            if (hero) hero.remove();
            console.warn(
                "[tuic-docs] Pagefind bundle not found at " +
                    bundlePath +
                    " — search disabled. Build the docs with `make docs`.",
            );
        });
})();
