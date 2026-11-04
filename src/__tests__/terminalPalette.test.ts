import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args: unknown) => Promise.resolve());
const warn = vi.fn((_scope: string, _message: string, _data?: unknown) => {});

vi.mock("../invoke", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("../stores/appLogger", () => ({
	appLogger: { warn: (scope: string, message: string, data?: unknown) => warn(scope, message, data) },
}));

import {
	cssColorToRgb,
	publishTerminalPalette,
	resetPublishedPaletteForTests,
} from "../components/Terminal/terminalPalette";

describe("cssColorToRgb", () => {
	it("parses the long hex our theme variables normally hold", () => {
		expect(cssColorToRgb("#1e1e1e")).toEqual([30, 30, 30]);
		expect(cssColorToRgb("#D4D4D4")).toEqual([212, 212, 212]);
	});

	it("expands short hex rather than misreading it as three channels", () => {
		expect(cssColorToRgb("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
		expect(cssColorToRgb("#fff")).toEqual([255, 255, 255]);
	});

	it("parses rgb() and rgba(), which getComputedStyle can return instead of hex", () => {
		expect(cssColorToRgb("rgb(30, 30, 30)")).toEqual([30, 30, 30]);
		expect(cssColorToRgb("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
		expect(cssColorToRgb("rgb(30 30 30)")).toEqual([30, 30, 30]);
	});

	it("tolerates the leading/trailing space getPropertyValue leaves behind", () => {
		expect(cssColorToRgb("  #1e1e1e  ")).toEqual([30, 30, 30]);
	});

	it("clamps out-of-range and rounds fractional channels", () => {
		expect(cssColorToRgb("rgb(300, -20, 12.6)")).toEqual([255, 0, 13]);
	});

	// Reporting a WRONG colour is acceptable (bad contrast). Reporting an INVENTED
	// one is not, so unparseable input must fall through to the caller's default
	// rather than silently becoming black.
	it("returns null for anything it cannot actually parse", () => {
		expect(cssColorToRgb("")).toBeNull();
		expect(cssColorToRgb("   ")).toBeNull();
		expect(cssColorToRgb("rebeccapurple")).toBeNull();
		expect(cssColorToRgb("var(--bg-secondary)")).toBeNull();
		expect(cssColorToRgb("#12345")).toBeNull();
	});
});

describe("publishTerminalPalette", () => {
	beforeEach(() => {
		invoke.mockClear();
		warn.mockClear();
		resetPublishedPaletteForTests();
	});

	it("sends the palette with the field names the backend deserializes", () => {
		publishTerminalPalette([212, 212, 212], [30, 30, 30], [212, 212, 212]);
		expect(invoke).toHaveBeenCalledWith("set_terminal_theme_colors", {
			foreground: [212, 212, 212],
			background: [30, 30, 30],
			cursor: [212, 212, 212],
		});
	});

	// Every open CanvasTerminal resolves the same variables and publishes on
	// remeasure, so one window resize would otherwise send one call per tab.
	it("publishes once for an unchanged palette, however often it is called", () => {
		for (let i = 0; i < 10; i++) publishTerminalPalette([1, 2, 3], [4, 5, 6], [7, 8, 9]);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("publishes again when the theme actually changes", () => {
		publishTerminalPalette([1, 2, 3], [4, 5, 6], [7, 8, 9]);
		publishTerminalPalette([1, 2, 3], [255, 255, 255], [7, 8, 9]);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("distinguishes palettes that differ only in cursor", () => {
		publishTerminalPalette([1, 2, 3], [4, 5, 6], [7, 8, 9]);
		publishTerminalPalette([1, 2, 3], [4, 5, 6], [9, 9, 9]);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("logs a failed publish instead of rejecting into the render path", async () => {
		invoke.mockImplementationOnce(() => Promise.reject(new Error("backend down")));
		expect(() => {
			publishTerminalPalette([1, 2, 3], [4, 5, 6], [7, 8, 9]);
		}).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(warn).toHaveBeenCalled();
	});
});
