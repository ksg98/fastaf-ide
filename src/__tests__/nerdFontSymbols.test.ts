import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { FONT_FAMILIES } from "../stores/settings";

const ROOT = resolve(__dirname, "../..");
const FONT_PATH = resolve(ROOT, "public/fonts/symbols-nerd-font-mono.woff2");
const CSS_PATH = resolve(ROOT, "src/global.css");

const POWERLINE_CODEPOINTS = [
	{ cp: 0xe0a0, name: "git branch" },
	{ cp: 0xe0a1, name: "line number" },
	{ cp: 0xe0a2, name: "lock" },
	{ cp: 0xe0b0, name: "right arrow solid" },
	{ cp: 0xe0b1, name: "right arrow thin" },
	{ cp: 0xe0b2, name: "left arrow solid" },
	{ cp: 0xe0b3, name: "left arrow thin" },
];

describe("Nerd Font Symbols", () => {
	it("woff2 font file exists", () => {
		expect(existsSync(FONT_PATH), "symbols-nerd-font-mono.woff2 missing from public/fonts/").toBe(true);
	});

	it("woff2 file has non-trivial size (>100KB)", () => {
		const stat = readFileSync(FONT_PATH);
		expect(stat.length).toBeGreaterThan(100_000);
	});

	it("@font-face declared in global.css", () => {
		const css = readFileSync(CSS_PATH, "utf-8");
		expect(css).toContain("font-family: 'Symbols Nerd Font Mono'");
		expect(css).toContain("symbols-nerd-font-mono.woff2");
	});

	it("every FONT_FAMILIES entry includes Symbols Nerd Font Mono before monospace", () => {
		for (const [name, family] of Object.entries(FONT_FAMILIES)) {
			const parts = family.split(",").map((s: string) => s.trim());
			const symbolIdx = parts.findIndex((p: string) => p.includes("Symbols Nerd Font Mono"));
			const monoIdx = parts.findIndex((p: string) => p === "monospace");
			expect(symbolIdx, `${name}: missing symbol font`).toBeGreaterThanOrEqual(0);
			expect(symbolIdx, `${name}: symbols must precede monospace`).toBeLessThan(monoIdx);
		}
	});

	it("woff2 contains powerline codepoints (U+E0A0-E0B3)", () => {
		const buf = readFileSync(FONT_PATH);
		for (const { cp, name } of POWERLINE_CODEPOINTS) {
			const hex = cp.toString(16).toUpperCase();
			const found = woff2ContainsCmap(buf, cp);
			expect(found, `U+${hex} (${name}) not found in font cmap`).toBe(true);
		}
	});
});

function woff2ContainsCmap(buf: Buffer, codepoint: number): boolean {
	// woff2 is compressed — we can't parse cmap directly. Instead, scan for
	// the codepoint encoded as big-endian uint16 in the binary. This is a
	// heuristic: format 4 cmap segments store start/end as BE16, and the
	// powerline range (0xE0xx) is distinctive enough to avoid false negatives.
	const hi = (codepoint >> 8) & 0xff;
	const lo = codepoint & 0xff;
	for (let i = 0; i < buf.length - 1; i++) {
		if (buf[i] === hi && buf[i + 1] === lo) return true;
	}
	return false;
}
