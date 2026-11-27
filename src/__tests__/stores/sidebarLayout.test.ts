import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

describe("sidebarLayout selectors", () => {
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let uiStore: typeof import("../../stores/ui").uiStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;
	let layout: typeof import("../../stores/sidebarLayout");

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		localStorage.clear();

		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: mockInvoke,
		}));

		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		uiStore = (await import("../../stores/ui")).uiStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		layout = await import("../../stores/sidebarLayout");
		repositoriesStore._testSetHydrated(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Flatten a grouped layout into repo paths in display order */
	const flatPaths = (l: ReturnType<typeof layout.getVisibleLayout>) => [
		...l.groups.flatMap((g) => g.repos.map((r) => r.path)),
		...l.ungrouped.map((r) => r.path),
	];

	const addRepo = (path: string, displayName: string) => {
		repositoriesStore.add({ path, displayName });
		repositoriesStore.setWorkspace(path, "main");
	};

	describe("getVisibleLayout()", () => {
		it("passes the raw layout through when no filters are active", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				addRepo("/b", "Beta");
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/a", "/b"]);
			});
		});

		it("workspace filter hides non-members and drops emptied groups", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				addRepo("/b", "Beta");
				addRepo("/c", "Gamma");
				const gid = repositoriesStore.createGroup("Work")!;
				repositoriesStore.addRepoToGroup("/b", gid);

				const ws = repositoriesStore.createNamedWorkspace("Client", ["/a", "/c"])!;
				repositoriesStore.setActiveNamedWorkspace(ws);

				const visible = layout.getVisibleLayout();
				// The group only contained /b (non-member) → dropped entirely
				expect(visible.groups).toHaveLength(0);
				expect(flatPaths(visible)).toEqual(["/a", "/c"]);
			});
		});

		it("keeps workspace membership entries for unknown repo paths harmless", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				const ws = repositoriesStore.createNamedWorkspace("Client", ["/a", "/removed-elsewhere"])!;
				repositoriesStore.setActiveNamedWorkspace(ws);
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/a"]);
			});
		});

		it("composes the workspace filter with the active-only filter", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				addRepo("/b", "Beta");
				addRepo("/c", "Gamma");
				repositoriesStore.addTerminalToWorkspace("/b", "main", "term-1");
				repositoriesStore.addTerminalToWorkspace("/c", "main", "term-2");

				const ws = repositoriesStore.createNamedWorkspace("Client", ["/a", "/b"])!;
				repositoriesStore.setActiveNamedWorkspace(ws);
				uiStore.setRepoFilterActiveOnly(true);

				// /a is a member but inactive; /c is active but not a member
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/b"]);
			});
		});

		// Catches: the "Live agents" layout (upstream's H view) filtering only inside
		// the sidebar component, so shortcut numbering still walks the hidden repos;
		// a plain shell or an exited agent counted as live; active-only winning over it.
		it("the live-agents layout keeps repos with a running agent and wins over active-only", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				addRepo("/b", "Beta");
				addRepo("/c", "Gamma");
				const shell = terminalsStore.add({ sessionId: "s1", fontSize: 14, name: "sh", cwd: "/b", awaitingInput: null });
				const agent = terminalsStore.add({ sessionId: "s2", fontSize: 14, name: "ag", cwd: "/c", awaitingInput: null });
				terminalsStore.update(agent, { agentType: "claude" });
				repositoriesStore.addTerminalToWorkspace("/b", "main", shell);
				repositoriesStore.addTerminalToWorkspace("/c", "main", agent);

				uiStore.setRepoFilterActiveOnly(true);
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/b", "/c"]);
				uiStore.setRepoFilterHarnessOnly(true);
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/c"]);
				expect(layout.getVisibleRepoSequence().map((r) => r.path)).toEqual(["/c"]);

				terminalsStore.update(agent, { shellState: "exited" });
				expect(flatPaths(layout.getVisibleLayout())).toEqual([]);

				uiStore.setRepoFilterHarnessOnly(false);
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/b", "/c"]);
			});
		});

		it("search filters case-insensitively on displayName", () => {
			testInScope(() => {
				addRepo("/a", "Frontend");
				addRepo("/b", "Backend");
				addRepo("/c", "docs");
				uiStore.setRepoSearchQuery("END");
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/a", "/b"]);
			});
		});

		it("sorts each group and the ungrouped list by name", () => {
			testInScope(() => {
				addRepo("/z", "zeta");
				addRepo("/a", "Alpha");
				addRepo("/g2", "grouped-b");
				addRepo("/g1", "grouped-a");
				const gid = repositoriesStore.createGroup("Work")!;
				repositoriesStore.addRepoToGroup("/g2", gid);
				repositoriesStore.addRepoToGroup("/g1", gid);

				repositoriesStore.setSortMode("name");
				const visible = layout.getVisibleLayout();
				expect(visible.groups[0].repos.map((r) => r.path)).toEqual(["/g1", "/g2"]);
				expect(visible.ungrouped.map((r) => r.path)).toEqual(["/a", "/z"]);
			});
		});

		it("recent sort orders by activation, leaving stored order untouched", () => {
			testInScope(() => {
				addRepo("/a", "Alpha");
				addRepo("/b", "Beta");
				vi.setSystemTime(1000);
				repositoriesStore.setActive("/a");
				vi.setSystemTime(2000);
				repositoriesStore.setActive("/b");

				repositoriesStore.setSortMode("recent");
				expect(flatPaths(layout.getVisibleLayout())).toEqual(["/b", "/a"]);
				expect(repositoriesStore.state.repoOrder).toEqual(["/a", "/b"]);
			});
		});
	});

	describe("getVisibleRepoSequence()", () => {
		it("skips repos in collapsed groups and collapsed/non-expanded repos", () => {
			testInScope(() => {
				addRepo("/grouped", "Grouped");
				addRepo("/folded", "Folded");
				addRepo("/shrunk", "Shrunk");
				addRepo("/plain", "Plain");
				const gid = repositoriesStore.createGroup("Work")!;
				repositoriesStore.addRepoToGroup("/grouped", gid);
				repositoriesStore.toggleGroupCollapsed(gid);
				repositoriesStore.toggleExpanded("/folded"); // expanded: false
				repositoriesStore.toggleCollapsed("/shrunk"); // collapsed: true

				expect(layout.getVisibleRepoSequence().map((r) => r.path)).toEqual(["/plain"]);
			});
		});

		it("orders grouped repos before ungrouped ones", () => {
			testInScope(() => {
				addRepo("/ungrouped", "Solo");
				addRepo("/grouped", "Grouped");
				const gid = repositoriesStore.createGroup("Work")!;
				repositoriesStore.addRepoToGroup("/grouped", gid);

				expect(layout.getVisibleRepoSequence().map((r) => r.path)).toEqual(["/grouped", "/ungrouped"]);
			});
		});

		it("respects the search filter (numbering matches what is rendered)", () => {
			testInScope(() => {
				addRepo("/a", "Frontend");
				addRepo("/b", "Backend");
				uiStore.setRepoSearchQuery("back");
				expect(layout.getVisibleRepoSequence().map((r) => r.path)).toEqual(["/b"]);
			});
		});
	});

	describe("getFirstVisibleRepo()", () => {
		it("returns the first repo in display order (groups before ungrouped)", () => {
			testInScope(() => {
				addRepo("/ungrouped", "Solo");
				addRepo("/grouped", "Grouped");
				const gid = repositoriesStore.createGroup("Work")!;
				repositoriesStore.addRepoToGroup("/grouped", gid);

				expect(layout.getFirstVisibleRepo()?.path).toBe("/grouped");
			});
		});

		it("returns the first search match even when its rows are collapsed", () => {
			testInScope(() => {
				addRepo("/a", "Frontend");
				addRepo("/b", "Backend");
				repositoriesStore.toggleCollapsed("/b");
				uiStore.setRepoSearchQuery("back");
				expect(layout.getFirstVisibleRepo()?.path).toBe("/b");
			});
		});

		it("returns undefined when nothing matches", () => {
			testInScope(() => {
				addRepo("/a", "Frontend");
				uiStore.setRepoSearchQuery("zzz");
				expect(layout.getFirstVisibleRepo()).toBeUndefined();
			});
		});
	});
});
