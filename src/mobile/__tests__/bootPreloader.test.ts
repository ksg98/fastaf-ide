// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve(__dirname, "../../../mobile.html"), "utf-8");
const watchdog = /<script>\s*\/\/ Boot watchdog[\s\S]*?<\/script>/.exec(html)?.[0].replace(/<\/?script>/g, "") ?? "";

describe("mobile.html boot preloader", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sessionStorage.clear();
		document.body.innerHTML = `<div id="mobile-preloader"><div id="pl-text">Loading</div><button id="pl-retry" hidden></button></div>`;
		(window as unknown as Record<string, unknown>).__tuicMobileReady = undefined;
		new Function(watchdog)();
	});
	afterEach(() => vi.useRealTimers());

	// Plausible bug: the shell paints from cache, its JS cannot load, and the page stays a blank dark screen.
	it("ships a preloader before the module script and wires its error event", () => {
		expect(html.indexOf('id="mobile-preloader"')).toBeGreaterThan(-1);
		expect(html).toMatch(/<script type="module"[^>]*onerror="window\.__tuicBootFail\(\)"/);
	});

	it("turns the preloader into a retry card when boot fails, backing off across attempts", () => {
		(window as unknown as { __tuicBootFail: () => void }).__tuicBootFail();
		expect(document.getElementById("mobile-preloader")?.className).toBe("failed");
		expect(document.getElementById("pl-text")?.textContent).toContain("Retrying in 5s");
		expect(document.getElementById("pl-retry")?.hidden).toBe(false);
		expect(sessionStorage.getItem("tuic-boot-delay")).toBe("10");
	});

	// Plausible bug: the 15s timeout fires after a slow but successful boot and replaces the app with an error card.
	it("stays out of the way once the app has mounted", () => {
		(window as unknown as Record<string, unknown>).__tuicMobileReady = true;
		vi.advanceTimersByTime(20000);
		expect(document.getElementById("mobile-preloader")?.className).toBe("");
	});
});
