import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPanelParams } from "../panelRouter";

describe("panel mode URL parsing", () => {
	let originalSearch: string;

	beforeEach(() => {
		originalSearch = window.location.search;
	});

	afterEach(() => {
		Object.defineProperty(window, "location", {
			value: { ...window.location, search: originalSearch },
			writable: true,
		});
	});

	function setSearch(qs: string) {
		Object.defineProperty(window, "location", {
			value: { ...window.location, search: qs },
			writable: true,
		});
	}

	it("detects panel mode from query", () => {
		setSearch("?mode=panel&panel=ai-chat");
		const result = getPanelParams();
		expect(result.isPanelMode).toBe(true);
		expect(result.panelId).toBe("ai-chat");
	});

	it("default mode has no panel param", () => {
		setSearch("");
		const result = getPanelParams();
		expect(result.isPanelMode).toBe(false);
		expect(result.panelId).toBeNull();
	});

	it("reads chatId from query in panel mode", () => {
		setSearch("?mode=panel&panel=ai-chat&chatId=abc123");
		const result = getPanelParams();
		expect(result.params.get("chatId")).toBe("abc123");
	});

	it("chatId is null when not provided", () => {
		setSearch("?mode=panel&panel=ai-chat");
		const result = getPanelParams();
		expect(result.params.get("chatId")).toBeNull();
	});

	it("detects activity panel mode", () => {
		setSearch("?mode=panel&panel=activity");
		const result = getPanelParams();
		expect(result.isPanelMode).toBe(true);
		expect(result.panelId).toBe("activity");
	});

	it("unknown panel returns valid params", () => {
		setSearch("?mode=panel&panel=nonexistent");
		const result = getPanelParams();
		expect(result.isPanelMode).toBe(true);
		expect(result.panelId).toBe("nonexistent");
	});

	it("reads arbitrary params from query", () => {
		setSearch("?mode=panel&panel=activity&foo=bar&baz=42");
		const result = getPanelParams();
		expect(result.params.get("foo")).toBe("bar");
		expect(result.params.get("baz")).toBe("42");
	});
});
