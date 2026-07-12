import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FontType } from "../stores/settings";

vi.mock("../invoke", () => ({
	invoke: vi.fn().mockResolvedValue([]),
}));

vi.mock("../stores/appLogger", () => ({
	appLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

/** Minimal Rust ThemeEntry fixture matching serde snake_case shape */
function makeRustEntry(overrides: {
	key?: string;
	name?: string;
	background?: string;
	foreground?: string;
	cursor?: string;
	ansi?: string[];
	app_chrome?: Record<string, string>;
}) {
	const defaults = {
		key: overrides.key ?? "test-theme",
		name: overrides.name ?? "Test Theme",
		terminal: {
			background: overrides.background ?? "#1e1e1e",
			foreground: overrides.foreground ?? "#d4d4d4",
			cursor: overrides.cursor ?? "#d4d4d4",
			cursor_accent: null,
			selection_background: null,
			ansi: overrides.ansi ?? [
				"#000000",
				"#cd3131",
				"#0dbc79",
				"#e5e510",
				"#2472c8",
				"#bc3fbc",
				"#11a8cd",
				"#e5e5e5",
				"#666666",
				"#f14c4c",
				"#23d18b",
				"#f5f543",
				"#3b8eea",
				"#d670d6",
				"#29b8db",
				"#ffffff",
			],
		},
		app_chrome: {
			bg_primary: "#1e1e1e",
			bg_secondary: "#252526",
			bg_tertiary: "#2d2d30",
			bg_highlight: "#37373d",
			fg_primary: "#cccccc",
			fg_secondary: "#a0a0a0",
			fg_muted: "#9aa1a9",
			accent: "#59a8dd",
			accent_hover: "#7abde5",
			border: "#3e3e42",
			success: "#4ade80",
			warning: "#dcdcaa",
			error: "#ef4444",
			text_on_accent: "#000000",
			text_on_error: "#000000",
			text_on_success: "#000000",
			...overrides.app_chrome,
		},
	};
	return defaults;
}

const DRACULA_ENTRY = makeRustEntry({
	key: "dracula",
	name: "Dracula",
	background: "#282a36",
	foreground: "#f8f8f2",
	cursor: "#f8f8f2",
	app_chrome: {
		bg_primary: "#282a36",
		accent: "#bd93f9",
		accent_hover: "#caa9fa",
	},
});

const VSCODE_DARK_ENTRY = makeRustEntry({
	key: "vscode-dark",
	name: "VS Code Dark",
	background: "#1e1e1e",
	foreground: "#d4d4d4",
	app_chrome: { bg_primary: "#1e1e1e" },
});

const NORD_ENTRY = makeRustEntry({
	key: "nord",
	name: "Nord",
	background: "#2e3440",
	foreground: "#d8dee9",
	app_chrome: { bg_primary: "#2e3440" },
});

const FIXTURES = [DRACULA_ENTRY, VSCODE_DARK_ENTRY, NORD_ENTRY];

describe("themes", () => {
	let invoke: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.resetModules();
		const invokeModule = await import("../invoke");
		invoke = invokeModule.invoke as ReturnType<typeof vi.fn>;
		invoke.mockClear();
	});

	describe("loadThemes()", () => {
		it("populates theme map from Rust entries", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getThemeNames, themesLoaded } = await import("../themes");

			expect(themesLoaded()).toBe(false);
			await loadThemes();
			expect(themesLoaded()).toBe(true);
			expect(invoke).toHaveBeenCalledWith("list_themes");

			const names = getThemeNames();
			expect(Object.keys(names)).toHaveLength(3);
			expect(names["dracula"]).toBe("Dracula");
			expect(names["nord"]).toBe("Nord");
		});

		it("handles backend failure gracefully", async () => {
			invoke.mockRejectedValueOnce(new Error("backend down"));
			const { loadThemes, themesLoaded, getThemeNames } = await import("../themes");
			await loadThemes();
			expect(themesLoaded()).toBe(false);
			expect(Object.keys(getThemeNames())).toHaveLength(0);
		});
	});

	describe("getTerminalTheme()", () => {
		it("returns the requested theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getTerminalTheme } = await import("../themes");
			await loadThemes();

			const theme = getTerminalTheme("dracula");
			expect(theme.background).toBe("#282a36");
			expect(theme.foreground).toBe("#f8f8f2");
		});

		it("falls back to vscode-dark for unknown key", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getTerminalTheme } = await import("../themes");
			await loadThemes();

			const theme = getTerminalTheme("nonexistent");
			expect(theme.background).toBe("#1e1e1e");
		});

		it("returns hardcoded fallback when themes not loaded", async () => {
			const { getTerminalTheme } = await import("../themes");
			const theme = getTerminalTheme("dracula");
			expect(theme.background).toBe("#1e1e1e");
			expect(theme.foreground).toBe("#cccccc");
		});
	});

	describe("getAppTheme()", () => {
		it("returns the requested app theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getAppTheme } = await import("../themes");
			await loadThemes();

			const theme = getAppTheme("dracula");
			expect(theme.bgPrimary).toBe("#282a36");
		});

		it("falls back to vscode-dark for unknown key", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getAppTheme } = await import("../themes");
			await loadThemes();

			const theme = getAppTheme("nonexistent");
			expect(theme.bgPrimary).toBe("#1e1e1e");
		});

		it("returns hardcoded fallback when themes not loaded", async () => {
			const { getAppTheme } = await import("../themes");
			const theme = getAppTheme("anything");
			expect(theme.bgPrimary).toBe("#1e1e1e");
			expect(theme.accent).toBe("#59a8dd");
		});
	});

	describe("getThemeNames()", () => {
		it("returns display names keyed by theme key", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getThemeNames } = await import("../themes");
			await loadThemes();

			const names = getThemeNames();
			expect(names).toEqual({
				dracula: "Dracula",
				"vscode-dark": "VS Code Dark",
				nord: "Nord",
			});
		});

		it("returns empty object when not loaded", async () => {
			const { getThemeNames } = await import("../themes");
			expect(getThemeNames()).toEqual({});
		});
	});

	describe("applyAppTheme()", () => {
		beforeEach(() => {
			document.documentElement.style.cssText = "";
		});

		it("sets CSS custom properties on document.documentElement", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, applyAppTheme } = await import("../themes");
			await loadThemes();

			applyAppTheme("dracula");
			const style = document.documentElement.style;
			expect(style.getPropertyValue("--bg-primary")).toBe("#282a36");
			expect(style.getPropertyValue("--accent")).toBe("#bd93f9");
		});

		it("falls back to vscode-dark for unknown theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, applyAppTheme } = await import("../themes");
			await loadThemes();

			applyAppTheme("nonexistent");
			const style = document.documentElement.style;
			expect(style.getPropertyValue("--bg-primary")).toBe("#1e1e1e");
		});

		it("warns when applying unknown theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, applyAppTheme } = await import("../themes");
			const { appLogger } = await import("../stores/appLogger");
			await loadThemes();

			applyAppTheme("nonexistent-theme");
			expect(appLogger.warn).toHaveBeenCalledWith("app", expect.stringContaining("nonexistent-theme"));
		});

		it("applies all 16 CSS variables from theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, applyAppTheme } = await import("../themes");
			await loadThemes();

			applyAppTheme("nord");
			const style = document.documentElement.style;

			const expectedVars = [
				"--bg-primary",
				"--bg-secondary",
				"--bg-tertiary",
				"--bg-highlight",
				"--fg-primary",
				"--fg-secondary",
				"--fg-muted",
				"--accent",
				"--accent-hover",
				"--border",
				"--success",
				"--warning",
				"--error",
				"--text-on-accent",
				"--text-on-error",
				"--text-on-success",
			];

			for (const varName of expectedVars) {
				const value = style.getPropertyValue(varName);
				expect(value, `${varName} should be set`).toBeTruthy();
				expect(value, `${varName} should be a hex color`).toMatch(/^#[0-9a-fA-F]{6}$/);
			}
		});

		it("overwrites previously applied theme", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, applyAppTheme } = await import("../themes");
			await loadThemes();

			applyAppTheme("dracula");
			applyAppTheme("nord");
			const style = document.documentElement.style;
			expect(style.getPropertyValue("--bg-primary")).toBe("#2e3440");
		});
	});

	describe("applyFontFamily()", () => {
		afterEach(() => {
			document.getElementById("tuic-font-override")?.remove();
		});

		it("injects a style tag with !important override for --font-mono", async () => {
			const { applyFontFamily } = await import("../themes");
			applyFontFamily("Fira Code");
			const tag = document.getElementById("tuic-font-override");
			expect(tag).not.toBeNull();
			expect(tag!.textContent).toContain("Fira Code");
			expect(tag!.textContent).toContain("monospace");
			expect(tag!.textContent).toContain("!important");
		});

		it("updates --font-mono when font changes", async () => {
			const { applyFontFamily } = await import("../themes");
			applyFontFamily("JetBrains Mono");
			const tag = document.getElementById("tuic-font-override")!;
			expect(tag.textContent).toContain("JetBrains Mono");

			applyFontFamily("Hack");
			expect(tag.textContent).toContain("Hack");
		});

		it("reuses the same style tag across calls", async () => {
			const { applyFontFamily } = await import("../themes");
			applyFontFamily("Fira Code");
			applyFontFamily("Hack");
			expect(document.querySelectorAll("#tuic-font-override").length).toBe(1);
		});

		it("falls back to JetBrains Mono for unknown font", async () => {
			const { applyFontFamily } = await import("../themes");
			applyFontFamily("Comic Sans" as FontType);
			const tag = document.getElementById("tuic-font-override")!;
			expect(tag.textContent).toContain("JetBrains Mono");
		});
	});

	describe("contrastRatio()", () => {
		it("returns 21:1 for black on white", async () => {
			const { contrastRatio } = await import("../themes");
			expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
		});

		it("returns 1:1 for identical colors", async () => {
			const { contrastRatio } = await import("../themes");
			expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 1);
		});
	});

	describe("ANSI color mapping", () => {
		it("maps ANSI colors to camelCase terminal theme keys", async () => {
			invoke.mockResolvedValueOnce(FIXTURES);
			const { loadThemes, getTerminalTheme } = await import("../themes");
			await loadThemes();

			const theme = getTerminalTheme("dracula");
			expect(theme.black).toBeDefined();
			expect(theme.red).toBeDefined();
			expect(theme.brightWhite).toBeDefined();
		});
	});
});
