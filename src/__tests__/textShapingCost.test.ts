import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the one CSS declaration that exists purely for layout performance.
 *
 * `-apple-system` resolves to SF Pro, a variable font. Every text width WebKit
 * cannot serve from cache is re-shaped through CoreText — GPOS pair lookups plus
 * variation-axis math. On a memory-pressured 8 GB Mac those caches are evicted
 * continuously, so the slow path becomes the only path: a sample there caught
 * `OTL::Coverage::SearchFmt2Binary` and `ItemVariationStore::ComputeScalar` on top
 * of a renderer pinned at 100% inside a relayout loop that never converged.
 *
 * Measured in a standalone WKWebView (120-row list, 40 relayouts, 3 runs each):
 * kerning on 110-116 ms, off 37-38 ms. `text-rendering` does not move it — macOS
 * kerns under `auto` too — so `font-kerning` is the lever.
 *
 * A bare `font-kerning: none` reads like a typo and invites a tidy-up, which is
 * why it is pinned here rather than left to a comment alone.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("text shaping cost", () => {
	it("turns kerning off for app chrome", () => {
		const css = read("src/global.css");
		const htmlBody = css.slice(css.indexOf("html, body {"));
		const rule = htmlBody.slice(0, htmlBody.indexOf("}"));
		expect(rule).toMatch(/font-kerning:\s*none/);
	});

	it("keeps kerning on for prose, which is read rather than scanned", () => {
		const css = read("src/components/ui/markdown-content.css");
		const root = css.slice(css.indexOf("#markdown-content {"));
		const rule = root.slice(0, root.indexOf("}"));
		expect(rule).toMatch(/font-kerning:\s*normal/);
	});
});
