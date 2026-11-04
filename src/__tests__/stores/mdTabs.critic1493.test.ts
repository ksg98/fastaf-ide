import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "tui-commander-mcp-markdown-reload";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe("MCP snapshot restore — critic 1493", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.resetModules();
	});

	// Catches: an invalid first entry claims the identity, or a later duplicate overwrites the first valid target.
	it("restores the first valid target after an invalid duplicate", async () => {
		const { mdTabsStore: md } = await import("../../stores/mdTabs");
		sessionStorage.setItem(
			KEY,
			JSON.stringify({
				tabs: [
					{ mcpUiId: "review", repoPath: "/r", filePath: "", pinned: true },
					{ mcpUiId: "review", repoPath: "/r", filePath: "first.md", pinned: false, branchKey: "/r|saved" },
					{ mcpUiId: "review", repoPath: "/other", filePath: "last.md", pinned: true },
				],
				activeMcpUiId: "review",
			}),
		);
		md.restoreAfterReload();
		expect(md.getCount()).toBe(1);
		expect(md.getActive()).toMatchObject({
			filePath: "first.md",
			repoPath: "/r",
			pinned: false,
			branchKey: "/r|saved",
		});
	});

	// Catches: restore loses the cross-kind order, reverses saved tabs, steals focus, or prevents subsequent normal opens/removals.
	it("appends saved documents after existing mixed tabs and keeps the editor pane active", async () => {
		const { mdTabsStore: md } = await import("../../stores/mdTabs");
		const { editorTabsStore: editor } = await import("../../stores/editorTabs");
		const { tabOrderingStore: ordering } = await import("../../stores/tabManager");
		const boot = md.addMcpFile("boot", "/r", "boot.md", true, true);
		const edit = editor.addMcpFile("edit", "/r", "live.ts", undefined, true, {
			background: false,
			externalEditable: false,
		});
		sessionStorage.setItem(
			KEY,
			JSON.stringify({
				tabs: [
					{ mcpUiId: "second", repoPath: "/r", filePath: "second.md", pinned: true },
					{ mcpUiId: "first", repoPath: "/r", filePath: "first.md", pinned: true },
				],
			}),
		);
		md.restoreAfterReload();
		const restored = md.getVisibleIds("/r|main", false);
		expect(restored.map((id) => md.get(id)?.mcpUiId)).toEqual(["boot", "second", "first"]);
		expect(ordering.getOrdered(new Set([boot, edit, ...restored]))).toEqual([boot, edit, ...restored.slice(1)]);
		expect(editor.state.activeId).toBe(edit);
		expect(md.state.activeId).toBeNull();
		md.closeMcpFile("second");
		const later = md.addMcpFile("later", "/r", "later.md", true, true);
		expect(ordering.getOrdered(new Set([boot, edit, ...md.getIds()]))).toEqual([boot, edit, restored[2], later]);
	});
});
