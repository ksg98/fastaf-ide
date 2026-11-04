import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "tui-commander-mcp-markdown-reload";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const seed = (ids: string[], active?: string) =>
	sessionStorage.setItem(
		KEY,
		JSON.stringify({
			tabs: ids.map((id) => ({ mcpUiId: id, repoPath: "/r", filePath: `${id}.md`, pinned: false })),
			activeMcpUiId: active,
		}),
	);
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { tabs: { mcpUiId: string }[] } | null;

async function fresh() {
	vi.resetModules();
	return (await import("../../stores/mdTabs")).mdTabsStore;
}

describe("mdTabs reload readiness gate — critic 1424 round 3", () => {
	beforeEach(() => sessionStorage.clear());
	afterEach(() => vi.restoreAllMocks());

	it("unarmed store: explicit save and mutations keep the unread snapshot — catches: gate checks only the computed, not saveForReload", async () => {
		seed(["old"]);
		const md = await fresh();
		md.addMcpFile("new", "/r", "new.md", false, true);
		md.saveForReload();
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["old"]);
	});

	it("corrupt snapshot still arms saving — catches: ready flag set only on the success path", async () => {
		sessionStorage.setItem(KEY, "{not json");
		const md = await fresh();
		md.restoreAfterReload();
		md.addMcpFile("a", "/r", "a.md", false, true);
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["a"]);
	});

	it("storage read that throws still arms saving — catches: getItem exception skips the finally arming", async () => {
		const md = await fresh();
		const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
			throw new Error("denied");
		});
		md.restoreAfterReload();
		spy.mockRestore();
		md.addMcpFile("a", "/r", "a.md", false, true);
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["a"]);
	});

	it("fresh MCP tab opened before restore is snapshotted together with restored ones — catches: arming snapshot not taken after restore", async () => {
		seed(["old"]);
		const md = await fresh();
		md.addMcpFile("new", "/r", "new.md", false, true);
		md.restoreAfterReload();
		expect(
			stored()
				?.tabs.map((t) => t.mcpUiId)
				.sort(),
		).toEqual(["new", "old"]);
	});

	it("user tab opened before restore never enters the snapshot after a reload — catches: file tab without mcpUiId persisted", async () => {
		seed(["old"]);
		const md = await fresh();
		md.add("/repo", "README.md");
		md.restoreAfterReload();
		md.saveForReload();
		const reloaded = await fresh();
		reloaded.restoreAfterReload();
		expect(Object.values(reloaded.state.tabs).map((t) => t.mcpUiId)).toEqual(["old"]);
	});

	it("restore called twice does not drop tabs: second call after arming keeps current snapshot — catches: re-entry consumes live tabs", async () => {
		seed(["a"]);
		const md = await fresh();
		md.restoreAfterReload();
		md.restoreAfterReload();
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["a"]);
	});

	it("arming is per module instance (per window): a new document starts unarmed — catches: readiness kept in sessionStorage or a global", async () => {
		const first = await fresh();
		first.restoreAfterReload();
		seed(["x"]);
		const second = await fresh();
		second.addMcpFile("y", "/r", "y.md", false, true);
		second.saveForReload();
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["x"]);
	});
});
