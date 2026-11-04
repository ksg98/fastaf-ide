import { describe, expect, it } from "vitest";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import { contrastRatio } from "../../../themes";
import { ATTR_DEFAULT_FG, decodeBinaryFrame, rowText } from "../canvasTerminalUtils";
import { createGridRenderer, type GridContext2D } from "../gridRenderer";
import fixture from "./fixtures/codex-answer-paragraphs-1872.json";

function hex(css: string): string {
	if (css.startsWith("#")) return css;
	return `#${css
		.match(/\d+/g)!
		.map((n) => Number(n).toString(16).padStart(2, "0"))
		.join("")}`;
}

const frame = decodeBinaryFrame(Uint8Array.from(atob(fixture.frameBase64), (c) => c.charCodeAt(0)).buffer)!;
const question = frame.rows.find((row) => rowText(row).startsWith("› Do not use tools"))!;
const renderer = () =>
	createGridRenderer({} as GridContext2D, { fontWeight: () => 400, getFontFamily: () => "monospace" });

describe("recorded user question band (#1897-dadb)", () => {
	it("keeps Paper default text readable on the recorded explicit SGR band", () => {
		// Catches: dark neutral SGR backgrounds bypass the light theme while text follows it.
		const grid = renderer();
		grid.setTheme(paper.appChrome.surface, paper.foreground, paper.appChrome.surfaceElevated);
		const c = 2;
		expect(question.attrs[c] & ATTR_DEFAULT_FG).toBeTruthy();
		expect(question.bg[c]).toBe(0x484848);
		const fg = grid.resolveFg(question.fg[c], question.bg[c], question.attrs[c]);
		const bg = grid.resolveBg(question.fg[c], question.bg[c], question.attrs[c]);
		expect(bg).toBe(paper.appChrome.surfaceElevated);
		expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
	});
	it("preserves dark themes and clears the Paper mapping on a theme switch", () => {
		// Catches: memoized light surfaces leak into dark terminal repaint.
		const grid = renderer();
		grid.setTheme("#f3f3f3", "#333333", "#e8e8e8");
		expect(grid.resolveBg(0, 0x484848, ATTR_DEFAULT_FG)).toBe("#e8e8e8");
		grid.setTheme("#252526", "#cccccc", "#2d2d30");
		expect(grid.resolveBg(0, 0x484848, ATTR_DEFAULT_FG)).toBe("rgb(72,72,72)");
	});

	it("preserves explicit foreground pairs and colored or readable neutral backgrounds", () => {
		// Catches: accessibility mapping overwrites intentional SGR color pairs.
		const grid = renderer();
		grid.setTheme("#f3f3f3", "#333333", "#e8e8e8");
		expect(grid.resolveBg(0xffffff, 0x484848, 0)).toBe("rgb(72,72,72)");
		expect(grid.resolveBg(0, 0x484849, ATTR_DEFAULT_FG)).toBe("rgb(72,72,73)");
		expect(grid.resolveBg(0, 0xffffff, ATTR_DEFAULT_FG)).toBe("rgb(255,255,255)");
	});
});
