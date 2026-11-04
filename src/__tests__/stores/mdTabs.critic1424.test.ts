import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "tui-commander-mcp-markdown-reload";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe("mdTabsStore MCP reload snapshot — critic 1424", () => {
	let md: typeof import("../../stores/mdTabs").mdTabsStore;
	let editor: typeof import("../../stores/editorTabs").editorTabsStore;

	beforeEach(async () => {
		sessionStorage.clear();
		vi.resetModules();
		md = (await import("../../stores/mdTabs")).mdTabsStore;
		editor = (await import("../../stores/editorTabs")).editorTabsStore;
	});

	/** Simulate unload → fresh module graph → init. Returns the fresh store. */
	async function reload() {
		md.restoreAfterReload(); // Finish startup before simulating unload.
		md.saveForReload();
		vi.resetModules();
		md = (await import("../../stores/mdTabs")).mdTabsStore;
		editor = (await import("../../stores/editorTabs")).editorTabsStore;
		return md;
	}

	const mcpIds = () =>
		Object.values(md.state.tabs)
			.map((t) => t.mcpUiId)
			.filter(Boolean);

	it("a tab closed before the next unload is not resurrected — catches: snapshot taken once and never refreshed", async () => {
		md.restoreAfterReload();
		md.addMcpFile("a", "/r", "a.md", true, true);
		md.addMcpFile("b", "/r", "b.md", true, true);
		md.saveForReload();
		md.closeMcpFile("a");
		await reload();
		md.restoreAfterReload();
		expect(mcpIds()).toEqual(["b"]);
	});

	it("restore consumes the snapshot: closing after restore and restoring again yields nothing — catches: snapshot left in storage", async () => {
		md.addMcpFile("a", "/r", "a.md", true, true);
		await reload();
		md.restoreAfterReload();
		md.closeMcpFile("a");
		md.restoreAfterReload();
		expect(mcpIds()).toEqual([]);
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it("restores order and selects the saved active tab, not the last — catches: active forced to last/first restored", async () => {
		md.addMcpFile("a", "/r", "a.md", true, true);
		md.addMcpFile("b", "/r", "b.md", true, true);
		md.addMcpFile("c", "/r", "c.md", true, true);
		md.setActive(
			md
				.getIds()
				.map((id) => md.get(id))
				.find((t) => t?.mcpUiId === "b")!.id,
		);
		await reload();
		md.restoreAfterReload();
		expect(md.state._order.map((id) => md.get(id)?.mcpUiId)).toEqual(["a", "b", "c"]);
		expect(md.getActive()?.mcpUiId).toBe("b");
	});

	it("no md tab active before reload (terminal was showing) → none active after — catches: restore steals the pane", async () => {
		md.addMcpFile("a", "/r", "a.md", true, true);
		expect(md.state.activeId).toBeNull();
		await reload();
		md.restoreAfterReload();
		expect(md.state.activeId).toBeNull();
	});

	it("user-opened file tabs are not captured as MCP tabs — catches: filter on type only", async () => {
		md.add("/r", "user.md");
		md.addMcpFile("a", "/r", "a.md", true, true);
		await reload();
		md.restoreAfterReload();
		expect(md.getCount()).toBe(1);
		expect(mcpIds()).toEqual(["a"]);
	});

	it("an editor tab already owning the id during boot wins over the snapshot — catches: duplicate identity across editor and md stores", async () => {
		md.addMcpFile("shared", "/r", "a.md", true, true);
		await reload();
		editor.addMcpFile("shared", "/r", "a.ts", undefined, true, { background: true, externalEditable: false });
		md.restoreAfterReload();
		expect(mcpIds()).toEqual([]);
	});

	it("a boot-time event for the same id keeps its target and is not made active by the snapshot — catches: snapshot overwrites fresh event", async () => {
		md.addMcpFile("a", "/r", "old.md", true, true);
		md.setActive(md.getIds()[0]);
		await reload();
		const fresh = md.addMcpFile("a", "/r", "new.md", true, true);
		md.restoreAfterReload();
		expect(md.getCount()).toBe(1);
		const tab = md.get(fresh);
		expect(tab?.type === "file" && tab.filePath).toBe("new.md");
		expect(md.state.activeId).toBeNull();
	});

	it("snapshot with the same id twice restores one tab — catches: missing dedupe within snapshot", () => {
		const t = { mcpUiId: "a", repoPath: "/r", filePath: "a.md", pinned: true };
		sessionStorage.setItem(KEY, JSON.stringify({ tabs: [t, { ...t, filePath: "b.md" }] }));
		md.restoreAfterReload();
		expect(md.getCount()).toBe(1);
	});

	it("preserves a saved branchKey and an absent one — catches: branchKey recomputed from current repo state", () => {
		sessionStorage.setItem(
			KEY,
			JSON.stringify({
				tabs: [
					{ mcpUiId: "a", repoPath: "/r", filePath: "a.md", pinned: false, branchKey: "/r|feature" },
					{ mcpUiId: "b", repoPath: "/r", filePath: "b.md", pinned: false },
				],
			}),
		);
		md.restoreAfterReload();
		const byId = (u: string) => Object.values(md.state.tabs).find((t) => t.mcpUiId === u);
		expect(byId("a")?.branchKey).toBe("/r|feature");
		expect(byId("b")?.branchKey).toBeUndefined();
		expect(byId("a")?.pinned).toBe(false);
	});

	describe("corrupt storage", () => {
		const cases: Array<[string, string]> = [
			["not json", "{oops"],
			["array root", "[1,2]"],
			["number root", "42"],
			["tabs not an array", JSON.stringify({ tabs: { a: 1 } })],
			["tab entries of wrong shape", JSON.stringify({ tabs: [null, 1, "x", [], {}] })],
			[
				"wrong field types",
				JSON.stringify({
					tabs: [
						{ mcpUiId: 5, repoPath: "/r", filePath: "a.md", pinned: true },
						{ mcpUiId: "a", repoPath: null, filePath: "a.md", pinned: true },
						{ mcpUiId: "a", repoPath: "/r", filePath: "", pinned: true },
						{ mcpUiId: "a", repoPath: "/r", filePath: "a.md", pinned: "yes" },
						{ mcpUiId: "a", repoPath: "/r", filePath: "a.md", pinned: true, branchKey: 3 },
						{ mcpUiId: "", repoPath: "/r", filePath: "a.md", pinned: true },
					],
				}),
			],
		];
		for (const [name, raw] of cases) {
			it(`${name}: no throw, no tabs, snapshot cleared — catches: corrupt snapshot crashes init or lingers`, () => {
				sessionStorage.setItem(KEY, raw);
				expect(() => md.restoreAfterReload()).not.toThrow();
				expect(md.getCount()).toBe(0);
				expect(sessionStorage.getItem(KEY)).toBeNull();
			});
		}

		it("one bad entry does not discard the good ones — catches: all-or-nothing validation", () => {
			sessionStorage.setItem(
				KEY,
				JSON.stringify({
					tabs: [null, { mcpUiId: "ok", repoPath: "/r", filePath: "a.md", pinned: true }],
				}),
			);
			md.restoreAfterReload();
			expect(mcpIds()).toEqual(["ok"]);
		});

		it("mcpUiId '__proto__' / 'constructor' does not pollute or throw — catches: id used as object key", () => {
			sessionStorage.setItem(
				KEY,
				JSON.stringify({
					tabs: [
						{ mcpUiId: "__proto__", repoPath: "/r", filePath: "a.md", pinned: true },
						{ mcpUiId: "constructor", repoPath: "/r", filePath: "b.md", pinned: true },
					],
					activeMcpUiId: "__proto__",
				}),
			);
			expect(() => md.restoreAfterReload()).not.toThrow();
			expect(({} as Record<string, unknown>).filePath).toBeUndefined();
			expect(md.getCount()).toBe(2);
		});

		it("oversized snapshots restore unique tabs with bounded identity enumeration — catches: quadratic growing-tab scans or duplicate resurrection", async () => {
			const values = Object.values;
			let enumeratedTabs = 0;
			const spy = vi.spyOn(Object, "values").mockImplementation((object) => {
				const result = values(object);
				if (object === md.state.tabs || object === editor.state.tabs) enumeratedTabs += result.length;
				return result;
			});
			try {
				for (const size of [5000, 10000]) {
					vi.resetModules();
					md = (await import("../../stores/mdTabs")).mdTabsStore;
					editor = (await import("../../stores/editorTabs")).editorTabsStore;
					md.addMcpFile("boot", "/r", "boot.md", true, true);
					const tabs = Array.from({ length: size }, (_, i) => ({
						mcpUiId: `id-${i % (size / 10)}`,
						repoPath: "/r",
						filePath: `f${i}.md`,
						pinned: true,
					}));
					sessionStorage.setItem(KEY, JSON.stringify({ tabs }));
					enumeratedTabs = 0;
					const started = performance.now();
					expect(() => md.restoreAfterReload()).not.toThrow();
					const elapsed = performance.now() - started;
					if (process.env.TUIC_RESTORE_TIMING)
						process.stdout.write(`restore ${size} entries: ${elapsed.toFixed(2)} ms\n`);
					expect(enumeratedTabs).toBeGreaterThan(0);
					expect(enumeratedTabs).toBeLessThanOrEqual(size * 2);
					expect(md.getCount()).toBe(1 + size / 10);
					expect(
						md.state._order.map((id) => {
							const tab = md.get(id);
							return tab?.type === "file" ? tab.filePath : undefined;
						}),
					).toEqual(["boot.md", ...Array.from({ length: size / 10 }, (_, i) => `f${i}.md`)]);
				}
			} finally {
				spy.mockRestore();
			}
		}, 30000); // Module setup is outside the complexity assertion.
	});

	it("saveForReload swallows a quota error — catches: throw in beforeunload skipping terminal snapshot", () => {
		md.restoreAfterReload();
		md.addMcpFile("a", "/r", "a.md", true, true);
		const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("quota", "QuotaExceededError");
		});
		try {
			expect(() => md.saveForReload()).not.toThrow();
		} finally {
			spy.mockRestore();
		}
	});

	it("saving with no MCP tabs overwrites a stale snapshot — catches: early return leaves old tabs to resurrect", () => {
		md.restoreAfterReload();
		md.addMcpFile("a", "/r", "a.md", true, true);
		md.saveForReload();
		md.closeMcpFile("a");
		md.saveForReload();
		md.restoreAfterReload();
		expect(md.getCount()).toBe(0);
	});
});
