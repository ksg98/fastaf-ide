import { createEffect, createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { locale, setLocale, t } from "../i18n";
import en from "../i18n/en.json";

const catalog: Record<string, string> = en;
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
	setLocale("en");
});

describe("en.json", () => {
	it("carries the English messages the UI asks for", () => {
		expect(Object.keys(catalog).length).toBeGreaterThan(0);
		expect(catalog["github.retry"]).toBe("Retry");
		expect(catalog["toolbar.commandPalette"]).toBe("Command palette ({key})");
	});
});

describe("t()", () => {
	it("returns the catalog message for a known key instead of the fallback", () => {
		expect(t("github.retry", "UNUSED FALLBACK")).toBe("Retry");
	});

	it("returns the fallback when the key is missing from the catalog", () => {
		expect(t("does.not.exist", "Plain fallback")).toBe("Plain fallback");
	});

	it("never renders the raw key for a missing key", () => {
		expect(t("does.not.exist", "Plain fallback")).not.toContain("does.not.exist");
		expect(t("", "Empty key fallback")).toBe("Empty key fallback");
	});

	it("falls back for a key that names an Object prototype member", () => {
		expect(t("constructor", "Prototype fallback")).toBe("Prototype fallback");
		expect(t("toString", "Prototype fallback")).toBe("Prototype fallback");
	});

	it("falls back for a locale that names an Object prototype member", () => {
		setLocale("constructor");
		expect(t("github.retry", "Prototype fallback")).toBe("Prototype fallback");
	});

	it("falls back without throwing for a locale that has no catalog", () => {
		setLocale("zz");
		expect(() => t("github.retry", "Retry")).not.toThrow();
		expect(t("github.retry", "Retry")).toBe("Retry");
	});

	it("substitutes params into a catalog message", () => {
		expect(t("toolbar.commandPalette", "UNUSED {key}", { key: "⌘P" })).toBe("Command palette (⌘P)");
	});

	it("substitutes params into the fallback when the key is missing", () => {
		expect(t("does.not.exist", "Hello {name}, you have {count} messages", { name: "Boss", count: "3" })).toBe(
			"Hello Boss, you have 3 messages",
		);
	});

	it("substitutes every occurrence of a placeholder", () => {
		expect(t("does.not.exist", "{a} and {a}", { a: "x" })).toBe("x and x");
	});

	it("leaves a placeholder untouched when no param matches it", () => {
		expect(t("does.not.exist", "Hello {name}", {})).toBe("Hello {name}");
		expect(t("does.not.exist", "Hello {name}")).toBe("Hello {name}");
	});

	it("re-runs a reactive computation when the locale changes", async () => {
		let dispose!: () => void;
		const seen: string[] = [];
		createRoot((d) => {
			dispose = d;
			createEffect(() => {
				seen.push(t("github.retry", "FALLBACK"));
			});
		});
		await flush();
		expect(seen).toEqual(["Retry"]);

		setLocale("zz");
		await flush();
		expect(seen).toEqual(["Retry", "FALLBACK"]);
		expect(locale()).toBe("zz");
		dispose();
	});
});
