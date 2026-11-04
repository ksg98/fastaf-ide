// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockOpenUrl } = vi.hoisted(() => ({ mockOpenUrl: vi.fn() }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mockOpenUrl }));

import { handleExternalLinkClick } from "../../utils/externalLinkClick";

/** Click the anchor's content; returns whether the handler claimed the click (jsdom would navigate otherwise). */
function click(html: string): boolean {
	document.body.innerHTML = html;
	let claimed = false;
	const settle = (e: Event) => {
		claimed = e.defaultPrevented;
		e.preventDefault();
	};
	document.addEventListener("click", settle);
	document.querySelector("a span, a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	document.removeEventListener("click", settle);
	return claimed;
}

describe("handleExternalLinkClick", () => {
	beforeEach(() => {
		mockOpenUrl.mockReset();
		document.addEventListener("click", handleExternalLinkClick);
	});
	afterEach(() => document.removeEventListener("click", handleExternalLinkClick));

	it("opens an http(s) link from a plain anchor in the system browser", () => {
		const claimed = click('<a href="https://example.com/x"><span>go</span></a>');
		expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/x");
		expect(claimed).toBe(true);
	});

	// Catches: judging `anchor.href`, which jsdom (like the dev server and browser mode) resolves to
	// http://localhost:3000/... for every relative or fragment link.
	it.each(["notes.md", "./notes.md", "../notes.md", "/abs/notes.md", "~/notes.md", "#section"])(
		"leaves the local link %s to the app",
		(href) => {
			click(`<a href="${href}">x</a>`);
			expect(mockOpenUrl).not.toHaveBeenCalled();
		},
	);

	it("leaves a Markdown link to ContentRenderer, which opens http(s) targets itself", () => {
		click('<a href="https://example.com/x" data-tuic-href="https://example.com/x">x</a>');
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});
});
