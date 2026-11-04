import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleOpenUrl = vi.hoisted(() => vi.fn());
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl }));

import { handleExternalLinkClick } from "../../utils/externalLinkClick";

function click(target: EventTarget): MouseEvent {
	const event = new MouseEvent("click", { bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

describe("handleExternalLinkClick (critic)", () => {
	beforeEach(() => {
		handleOpenUrl.mockClear();
		document.addEventListener("click", handleExternalLinkClick);
	});
	afterEach(() => {
		document.removeEventListener("click", handleExternalLinkClick);
		document.body.innerHTML = "";
	});

	it.each([
		["mailto", "mailto:a@b.c"],
		["tuic scheme", "tuic://open//tmp/x.md"],
		["protocol-relative", "//example.com/x"],
		["relative file", "design.md"],
		["fragment", "#section"],
		["absolute path", "/Users/me/x.md"],
		["home path", "~/notes/x.md"],
		["file line link", "src/lib.rs:42"],
	])("leaves a %s link to its own handler", (_name, href) => {
		document.body.innerHTML = `<a href="${href}"><span id="t">x</span></a>`;
		const event = click(document.getElementById("t") as HTMLElement);
		expect(handleOpenUrl).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("opens an upper-case scheme once — catches: case-sensitive scheme test dropping HTTPS:// to WebView navigation", () => {
		document.body.innerHTML = `<a href="HTTPS://example.com/A">x</a>`;
		const event = click(document.querySelector("a") as HTMLElement);
		expect(handleOpenUrl).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("opens a link whose href has surrounding whitespace — catches: getAttribute text not trimmed like anchor.href was, so the WebView navigates with the 'dangerous link' dialog", () => {
		document.body.innerHTML = `<a href="  https://example.com/x ">x</a>`;
		const event = click(document.querySelector("a") as HTMLElement);
		expect(handleOpenUrl).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("opens a link inside an inline SVG — catches: selector matching only HTML anchors", () => {
		document.body.innerHTML = `<svg><a href="https://example.com/s"><text id="t">x</text></a></svg>`;
		const event = click(document.getElementById("t") as unknown as HTMLElement);
		expect(handleOpenUrl).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores a markdown link even when its href is absolute http — catches: double open with ContentRenderer", () => {
		document.body.innerHTML = `<a href="https://example.com/m" data-tuic-href="https://example.com/m">x</a>`;
		const event = click(document.querySelector("a") as HTMLElement);
		expect(handleOpenUrl).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not throw for a click dispatched on the document itself — catches: closest() called on a non-element target", () => {
		expect(() => handleExternalLinkClick({ target: document } as unknown as MouseEvent)).not.toThrow();
		expect(handleOpenUrl).not.toHaveBeenCalled();
	});

	it.each(["https:example.com/x", "http:/example.com/x"])(
		"opens the scheme-only absolute form %s — catches: regex requiring '//' so the WebView navigates where anchor.href used to be intercepted",
		(href) => {
			document.body.innerHTML = `<a href="${href}">x</a>`;
			const event = click(document.querySelector("a") as HTMLElement);
			expect(handleOpenUrl).toHaveBeenCalledTimes(1);
			expect(event.defaultPrevented).toBe(true);
		},
	);
});
