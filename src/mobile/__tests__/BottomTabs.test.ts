import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../components/BottomTabs.module.css"), "utf-8");

describe("BottomTabs CSS (mobile)", () => {
	it("defines a real (non-transparent) background", () => {
		// Must be a genuine fill, not `none`/`transparent` — without the frosted
		// blur the bar relies on its background for legibility over content.
		// \S anchors the value: with bare \s* the regex backtracks to zero blanks and
		// lets "transparent" and "none" slip past the lookahead.
		const match = css.match(/background:\s*(?!none\b|transparent\b)\S[^;]*/);
		expect(match, "no opaque background found in BottomTabs.module.css").toBeTruthy();
	});

	it("does not use backdrop-filter (mobile glassmorphism ban — desktop is exempt per DESIGN.md §4)", () => {
		const match = css.match(/backdrop-filter/);
		expect(match).toBeNull();
	});
});

describe("BottomTabs height", () => {
	const fabCss = readFileSync(resolve(__dirname, "../screens/SessionsScreen.module.css"), "utf-8");
	const tabsRule = css.match(/\.tabs\s*\{([^}]*)\}/)?.[1] ?? "";

	// Catches: the tab bar growing by the home-indicator inset (56 + 34 px) and covering the
	// new-session button, which sits a fixed 76 px above the shell bottom.
	it("keeps a fixed 56px bar that stays below the new-session button", () => {
		expect(tabsRule).toMatch(/(^|[;\s])height:\s*56px;/);
		expect(tabsRule).toMatch(/padding-bottom:\s*0;/);
		const fabBottom = fabCss.match(/\.fab\s*\{[^}]*bottom:\s*calc\((\d+)px \+ (\d+)px\)/);
		expect(fabBottom, "no .fab bottom offset found").toBeTruthy();
		expect(Number(fabBottom![1]) + Number(fabBottom![2])).toBeGreaterThan(56);
	});
});
