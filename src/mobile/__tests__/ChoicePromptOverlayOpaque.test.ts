import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../components/ChoicePromptOverlay.module.css"), "utf-8");
const dropup = css.match(/\.dropup\s*\{([^}]*)\}/)?.[1] ?? "";
const background = dropup.match(/(?:^|[;\s])background:\s*([^;]+);/)?.[1].trim() ?? "";

describe("ChoicePromptOverlay surface", () => {
	// Catches: a translucent dropup lets the terminal rows it repeats (question, options, footer)
	// show through the sheet, so the question text renders twice on top of itself (#1766-9311).
	it("covers the terminal rows beneath it with an opaque background", () => {
		expect(background).not.toBe("");
		const alpha = background.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
		expect(alpha === null || Number(alpha[1]) === 1).toBe(true);
	});
});
