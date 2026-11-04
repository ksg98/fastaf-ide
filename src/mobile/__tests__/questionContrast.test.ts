import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import paper from "../../../src-tauri/src/themes/vscode-light.json";
import { contrastRatio } from "../../themes";

const css = (file: string) => readFileSync(`src/mobile/${file}`, "utf8");
const banner = css("components/QuestionBanner.module.css");
const badge = css("components/StatusBadge.module.css");
const card = css("components/SessionCard.module.css");
const palette = css("mobile.css");
function declarations(source: string, selector: string): Record<string, string> {
	const block =
		[...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
			(match) => match[1].trim() === selector,
		)?.[2] ?? "";
	return Object.fromEntries([...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const tokens = {
	...declarations(palette, ":root"),
	"--bg-primary": paper.appChrome.background,
	"--bg-highlight": paper.appChrome.highlight,
	"--fg-primary": paper.appChrome.foreground,
	"--warning": paper.appChrome.warning,
};
type RGB = number[];
const mix = (top: RGB, bottom: RGB, alpha: number) => top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
function color(value: string, under: RGB): RGB {
	const variable = /^var\((--[\w-]+)\)$/.exec(value);
	if (variable) return color(tokens[variable[1] as keyof typeof tokens], under);
	if (value.startsWith("#")) return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
	const rgba = /^rgba\(([^)]+)\)$/.exec(value);
	if (rgba) {
		const parts = rgba[1].split(",").map(Number);
		return mix(parts.slice(0, 3), under, parts[3]);
	}
	const blend = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (transparent|var\(--[\w-]+\))\)$/.exec(value);
	if (blend)
		return mix(
			color(blend[1], under),
			blend[3] === "transparent" ? under : color(blend[3], under),
			Number(blend[2]) / 100,
		);
	throw new Error(`Unsupported color: ${value}`);
}
const hex = (rgb: RGB) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function ratio(fg: RGB, bg: RGB) {
	return contrastRatio(hex(fg), hex(bg));
}
function lightStyle(source: string, selector: string) {
	return {
		...declarations(source, selector),
		...declarations(source, `:global(html[data-theme="vscode-light"]) ${selector}`),
	};
}

describe("mobile Paper question text contrast", () => {
	// Catches: dark-only urgent yellow reused for small names on pale banner surfaces.
	it.each([false, true])("keeps banner names readable when pressed=%s", (pressed) => {
		const surface = color(tokens["--bg-primary"], []);
		const bg = color(declarations(banner, pressed ? ".banner:active" : ".banner").background, surface);
		const fg = color(lightStyle(banner, ".agent").color, bg);
		expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
	});

	// Catches: pale attention text, including the pulse minimum, on tinted question cards.
	it.each([1, 0.5])("keeps Input readable through pulse opacity %s", (opacity) => {
		const surface = color(tokens["--bg-primary"], []);
		const parent = color(declarations(card, ".card.question").background, surface);
		const style = lightStyle(badge, ".question");
		const effectiveOpacity = style.animation === "none" ? 1 : opacity;
		const bg = mix(color(style.background, parent), parent, effectiveOpacity);
		const fg = mix(color(style.color, parent), parent, effectiveOpacity);
		expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
	});
});
