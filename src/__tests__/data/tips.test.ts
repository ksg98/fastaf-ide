import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TIPS } from "../../data/tips";

/** A `{ key: "…", label: … }` nav entry: a literal label or a `t(key, "Default")` one. */
const NAV_ENTRY = /\{\s*key:\s*"[^"]+",\s*label:\s*(?:t\("[^"]+",\s*"([^"]+)"\)|"([^"]+)")\s*\}/g;

/** Page labels of the global Settings nav, read from `GLOBAL_TAB_GROUPS` in the
 * panel source so a renamed or removed page fails here, not in front of a user.
 * `ALL_SETTINGS_TAB` is declared on its own (the nav lists it only while Expert
 * is on) and referenced from the groups by name, so it is read separately. */
function settingsPageLabels(): Set<string> {
	const src = fs.readFileSync(path.join(__dirname, "../../components/SettingsPanel/SettingsPanel.tsx"), "utf8");
	const start = src.indexOf("const GLOBAL_TAB_GROUPS");
	const body = src.slice(start, src.indexOf("\n];", start));
	const labels = new Set<string>();
	for (const m of body.matchAll(NAV_ENTRY)) labels.add(m[1] ?? m[2]);
	const named = src.match(/const ALL_SETTINGS_TAB\b[^=]*=\s*(\{[^}]*\})/);
	if (named && body.includes("ALL_SETTINGS_TAB")) {
		for (const m of named[1].matchAll(NAV_ENTRY)) labels.add(m[1] ?? m[2]);
	}
	return labels;
}

/** Every "Settings → Page" / "Settings > Page" a tip names, with its page. */
function settingsPaths(): { feature: string; page: string }[] {
	return TIPS.flatMap((tip) =>
		[
			...tip.description.matchAll(
				/Settings\s*(?:→|>)\s*([A-Z][\w&]*(?:\s(?:&\s)?(?:[A-Z][\w&]*|settings|plugins))*(?:\s\(Expert\))?)/g,
			),
		].map((m) => ({
			feature: tip.feature,
			page: m[1],
		})),
	);
}

describe("tips", () => {
	it("reads the Settings pages from the panel source", () => {
		// Guards the parser: an empty set would make the next test pass vacuously.
		expect([...settingsPageLabels()]).toEqual(
			expect.arrayContaining(["General", "All settings (Expert)", "Agents", "MCP", "Git & GitHub"]),
		);
		expect(settingsPaths().length).toBeGreaterThan(0);
	});

	it("names only Settings pages that exist in the navigation", () => {
		const pages = settingsPageLabels();
		const stale = settingsPaths().filter(({ page }) => !pages.has(page));
		expect(stale).toEqual([]);
	});

	// The protocol is always on (`kitty_keyboard: true` in the terminal grid) and
	// an agent turns it on by requesting it. No Settings page has ever had a
	// toggle for it, so a tip that sends the user looking for one is wrong.
	it("does not send the user to Settings for the Kitty keyboard protocol", () => {
		const kitty = TIPS.find((tip) => tip.feature === "Kitty Keyboard Protocol");
		expect(kitty).toBeDefined();
		expect(kitty?.description).not.toMatch(/Settings/);
	});
});
