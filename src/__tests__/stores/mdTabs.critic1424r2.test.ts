import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "tui-commander-mcp-markdown-reload";

async function freshStore() {
	vi.resetModules();
	return (await import("../../stores/mdTabs")).mdTabsStore;
}

describe("critic 1424 round 2: per-change MCP Markdown snapshots", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		sessionStorage.clear();
	});

	// Catches: a second reload during boot (beforeunload -> saveForReload before restoreAfterReload) wipes the snapshot of the first reload.
	it("keeps the prior snapshot when saveForReload runs before restore", async () => {
		const old = await freshStore();
		old.restoreAfterReload();
		old.addMcpFile("boss-digest", "", "/Users/boss/Gits/digest.md", false, false);
		const saved = sessionStorage.getItem(KEY);
		expect(saved).not.toBeNull();

		const booting = await freshStore(); // restore has not run yet
		booting.saveForReload(); // beforeunload fired mid-boot
		expect(sessionStorage.getItem(KEY)).toBe(saved);

		const third = await freshStore();
		third.restoreAfterReload();
		expect(third.getCount()).toBe(1);
	});

	// Catches: a tab opened by a fresh MCP event during boot overwrites the unread snapshot before restore.
	it("does not overwrite the snapshot when a tab opens before restore", async () => {
		const old = await freshStore();
		old.restoreAfterReload();
		old.addMcpFile("boss-digest", "", "/Users/boss/Gits/digest.md", false, false);
		const saved = sessionStorage.getItem(KEY);

		const booting = await freshStore();
		booting.addMcpFile("other", "", "/Users/boss/Gits/other.md", false, false);
		expect(sessionStorage.getItem(KEY)).toBe(saved);
		booting.restoreAfterReload();
		expect(booting.getCount()).toBe(2);
	});

	// Catches: a throwing sessionStorage.setItem (quota/privacy mode) propagates out of the store mutation.
	it("keeps the store usable when sessionStorage.setItem throws", async () => {
		const store = await freshStore();
		store.restoreAfterReload();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		let id = "";
		expect(() => {
			id = store.addMcpFile("boss-digest", "", "/Users/boss/Gits/digest.md", false, false);
		}).not.toThrow();
		expect(store.get(id)).toMatchObject({ mcpUiId: "boss-digest" });
		expect(() => store.setPinned(id, true)).not.toThrow();
		expect(() => store.remove(id)).not.toThrow();
		expect(store.getCount()).toBe(0);
	});

	// Catches: closeMcpFile / clearAll leave a stale snapshot that resurrects the document.
	it("removes the snapshot when the last MCP document is closed by identity or clearAll", async () => {
		const store = await freshStore();
		store.restoreAfterReload();
		store.addMcpFile("a", "", "/a.md", false, false);
		store.closeMcpFile("a");
		expect(sessionStorage.getItem(KEY)).toBeNull();
		store.addMcpFile("b", "", "/b.md", false, false);
		store.clearAll();
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	// Catches: switching the active tab to a non-MCP tab leaves the old activeMcpUiId in the snapshot.
	it("records no active MCP id after activation moves to a plain markdown tab", async () => {
		const store = await freshStore();
		store.restoreAfterReload();
		store.addMcpFile("a", "", "/a.md", false, false);
		store.add("/repo", "README.md");
		expect(JSON.parse(sessionStorage.getItem(KEY) ?? "{}").activeMcpUiId).toBeUndefined();
	});
});
