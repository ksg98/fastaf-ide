import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const KEY = "tui-commander-mcp-markdown-reload";
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { tabs: { mcpUiId: string }[] } | null;

async function fresh() {
	vi.resetModules();
	return (await import("../../stores/mdTabs")).mdTabsStore;
}

describe("mdTabs restoreAfterReload once-per-document — critic 1424 round 4", () => {
	beforeEach(() => sessionStorage.clear());

	it("a second restore leaves a later snapshot untouched and adds no tab — catches: guard missing so a repeat call consumes/replays storage", async () => {
		const md = await fresh();
		md.restoreAfterReload();
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ tabs: [{ mcpUiId: "x", repoPath: "", filePath: "/x.md", pinned: false }] }),
		);
		md.restoreAfterReload();
		expect(md.getCount()).toBe(0);
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["x"]);
	});

	it("restored tabs are re-written at arming, so a second native reload without beforeunload keeps them — catches: snapshot consumed on restore and only rewritten after the next change", async () => {
		sessionStorage.setItem(
			KEY,
			JSON.stringify({ tabs: [{ mcpUiId: "x", repoPath: "", filePath: "/x.md", pinned: true }] }),
		);
		const md = await fresh();
		md.restoreAfterReload();
		expect(stored()?.tabs.map((t) => t.mcpUiId)).toEqual(["x"]);
		const again = await fresh();
		again.restoreAfterReload();
		expect(again.getCount()).toBe(1);
	});
});
