import { handleOpenUrl } from "./openUrl";

/**
 * Document-level click handler that sends external http(s) links to the system
 * browser. Without it Tauri shows a "link could potentially be dangerous" dialog.
 *
 * It decides on the link text as written (`getAttribute`), never on `anchor.href`:
 * the resolved URL of a relative or `#` link is `http://<app origin>/...` whenever
 * the page is served over http (dev server, browser mode), which would open the
 * app's own origin in the browser for every local link.
 *
 * Anchors carrying `data-tuic-href` are dispatched by their own component
 * (ContentRenderer for Markdown links, the AI Chat transcript for web links),
 * which also opens http(s) targets; handling them here would open them twice.
 */
export function handleExternalLinkClick(e: MouseEvent): void {
	// A click dispatched on the document or a text node has no `closest`.
	if (!(e.target instanceof Element)) return;
	const anchor = e.target.closest("a[href]");
	if (!anchor || anchor.hasAttribute("data-tuic-href")) return;
	// `anchor.href` normalised this the WHATWG way; the attribute does not: tab/newline are dropped
	// anywhere, leading C0 controls and spaces are trimmed.
	const href = anchor
		.getAttribute("href")
		?.replace(/[\t\n\r]/g, "")
		.replace(/^[\u0000-\u0020]+/, "")
		.trimEnd();
	// Scheme only: `https:example.com` and `http:/x` also resolve to http URLs; handleOpenUrl validates.
	if (href && /^https?:/i.test(href)) {
		e.preventDefault();
		handleOpenUrl(href);
	}
}
