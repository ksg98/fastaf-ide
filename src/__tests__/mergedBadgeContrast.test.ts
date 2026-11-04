import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import codexDark from "../../src-tauri/src/themes/codex-dark.json";
import paper from "../../src-tauri/src/themes/vscode-light.json";
import { contrastRatio } from "../themes";

const sidebarCss = readFileSync("src/components/Sidebar/Sidebar.module.css", "utf8");
const globalCss = readFileSync("src/global.css", "utf8");

// Resolve the shipped badge declarations and their flat CSS token scopes without
// claiming browser rendering.
function declarations(css: string, selector: string): Record<string, string> {
	const block = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
		(match) => match[1].trim() === selector,
	)?.[2];
	if (!block) throw new Error(`Missing CSS scope: ${selector}`);
	return Object.fromEntries(
		[...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
	);
}

function resolve(value: string, tokens: Record<string, string>): string {
	const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
	if (!token) return value;
	if (!tokens[token]) throw new Error(`Missing CSS token: ${token}`);
	return resolve(tokens[token], tokens);
}

function rgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function hex(channels: number[]): string {
	return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `color-mix(in srgb, <color> N%, transparent)` painted over `surface`. */
function tintOver(value: string, tokens: Record<string, string>, surface: string): string {
	const match = /^color-mix\(in srgb,\s*(var\(--[\w-]+\)|#[0-9a-f]{6})\s+(\d+)%,\s*transparent\)$/i.exec(value);
	if (!match) throw new Error(`Unexpected badge background: ${value}`);
	const tint = rgb(resolve(match[1], tokens));
	const alpha = Number(match[2]) / 100;
	const base = rgb(surface);
	return hex(base.map((c, i) => tint[i] * alpha + c * (1 - alpha)));
}

describe("merged PR badge contrast (FastAF tinted pill)", () => {
	// Catches: a palette or tint change leaving the small merged label unreadable on
	// its own tinted pill, over the sidebar surface it actually sits on.
	it.each([
		{ name: "Codex Dark", theme: codexDark, selector: undefined },
		{ name: "Paper", theme: paper, selector: '[data-theme="vscode-light"]' },
	])("keeps $name labels at WCAG AA on the tinted pill", ({ theme, selector }) => {
		const tokens = {
			...declarations(globalCss, ":root"),
			...(selector ? declarations(globalCss, selector) : {}),
		};
		const badge = declarations(sidebarCss, ".prMerged");
		const foreground = resolve(badge.color, tokens);
		const background = tintOver(badge.background, tokens, theme.appChrome.surface);
		expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
	});
});
