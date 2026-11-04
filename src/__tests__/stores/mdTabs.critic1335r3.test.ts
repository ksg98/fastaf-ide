import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

describe("mdTabsStore MCP id image <-> markdown lifecycle (critic round 3)", () => {
	let store: typeof import("../../stores/mdTabs").mdTabsStore;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		store = (await import("../../stores/mdTabs")).mdTabsStore;
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		repositoriesStore._testSetHydrated(true);
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
	});

	const tabsFor = (mcpUiId: string) =>
		Object.values(store.state.tabs).filter((t) => "mcpUiId" in t && t.mcpUiId === mcpUiId);

	// Catches: image -> md -> image -> md cycles leaking one tab per round trip.
	it("repeated image/markdown flips on one id leave exactly one tab", () => {
		testInScope(() => {
			for (let i = 0; i < 3; i++) {
				store.closeMcpFile("u1");
				store.addMcpHtmlPreview("u1", "/repo", "a.png", false, false);
				expect(tabsFor("u1")).toHaveLength(1);
				store.closeMcpFile("u1");
				store.addMcpFile("u1", "/repo", "a.md", false, false);
				store.addMcpFile("u1", "/repo", "b.md", false, false);
				expect(tabsFor("u1")).toHaveLength(1);
				expect(tabsFor("u1")[0].type).toBe("file");
			}
		});
	});

	// Catches: dropping a stale image tab removes an image tab owned by a DIFFERENT mcp id.
	it("addMcpFile for one id leaves another id's image tab alone", () => {
		testInScope(() => {
			const other = store.addMcpHtmlPreview("other", "/repo", "x.png", true, false);
			store.addMcpHtmlPreview("u1", "/repo", "a.png", false, false);
			store.addMcpFile("u1", "/repo", "a.md", false, false);
			expect(store.get(other)).toBeDefined();
			expect(tabsFor("u1")).toHaveLength(1);
		});
	});

	// Catches: a user-opened preview of the same file (no mcpUiId) swallowed by the stale drop.
	it("addMcpFile keeps a user-opened html preview that has no mcp id", () => {
		testInScope(() => {
			const user = store.addHtmlPreview("/repo", "a.html");
			store.addMcpFile("u1", "/repo", "a.md", false, false);
			expect(store.get(user)).toBeDefined();
		});
	});

	// Catches: pinned flag dropped / coerced to undefined for the image tab.
	it.each([true, false])("image tab records pinned=%s exactly", (pinned) => {
		testInScope(() => {
			const id = store.addMcpHtmlPreview("u1", "/repo", "a.png", pinned, false);
			expect(store.get(id)?.pinned).toBe(pinned);
		});
	});

	// Catches: the background markdown tab becoming active when it replaces the focused image tab.
	it("background markdown replacing an active image tab does not become active", () => {
		testInScope(() => {
			store.addMcpHtmlPreview("u1", "/repo", "a.png", false, false);
			const md = store.addMcpFile("u1", "/repo", "a.md", false, true);
			expect(store.state.activeId).not.toBe(md);
			expect(tabsFor("u1")).toHaveLength(1);
		});
	});
});
