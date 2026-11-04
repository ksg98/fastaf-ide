import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Adversarial cases for #1329-a31a. CSS is read from source because jsdom
// cannot hit-test a finger.

const css = (file: string) => readFileSync(resolve(__dirname, "..", file), "utf8");

const ruleBody = (source: string, selector: string) => {
	const start = source.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`no rule ${selector}`);
	return source.slice(start, source.indexOf("}", start));
};

describe("touch critic cases (#1329-a31a)", () => {
	// Catches: replacing `manipulation` with bare `pan-x pan-y` drops pinch-zoom for
	// every touch-primary device (page zoom is an accessibility feature).
	it("global touch rule keeps pinch-zoom available", () => {
		const source = css("global.css");
		const start = source.indexOf("@media (hover: none)");
		const block = source.slice(start, source.indexOf("\n}\n", start));
		expect(block).toMatch(/touch-action:\s*[^;]*pinch-zoom/);
	});

	// Catches: a + button with a long-press agent list left pannable, so a finger
	// wobble raises pointercancel and cancels the press timer (long press never opens).
	it.each([
		["components/Sidebar/Sidebar.module.css", ".branchAddBtn"],
		["components/TabBar/TabBar.module.css", ".newBtn"],
	])("%s %s opts out of panning", (file, selector) => {
		expect(ruleBody(css(file), selector)).toMatch(/touch-action:\s*none/);
	});

	// Catches: the touch-only sidebar rule leaking to hover-capable desktops
	// (actions permanently visible with a mouse).
	it("sidebar always-visible actions are confined to (hover: none)", () => {
		const source = css("components/Sidebar/Sidebar.module.css");
		const base = ruleBody(source, ".branchActions");
		expect(base).toContain("opacity: 0");
		expect(base).toContain("pointer-events: none");
	});
});
