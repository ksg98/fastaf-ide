import { beforeEach, describe, expect, it } from "vitest";
import { type BaseTab, createTabManager, makeBranchKey } from "../../stores/tabManager";
import { testInScope } from "../helpers/store";

// A minimal tab type for tests
interface TestTab extends BaseTab {
	id: string;
	label: string;
	pinned?: boolean;
	branchKey?: string;
}

function makeTab(id: string, overrides: Partial<TestTab> = {}): TestTab {
	return { id, label: `Tab ${id}`, ...overrides };
}

/**
 * Park `activeId` on a neutral, always-visible tab.
 *
 * `_addTab` activates whatever it just added, and `getVisibleIds` exempts the
 * active tab from scoping (a hidden active tab is a ghost pane — content the
 * user cannot name or close). So a scoping test whose subject happens to be the
 * LAST tab added is answered by that exemption rather than by the rule it means
 * to check, and would keep passing if the rule were deleted.
 */
function parkActive(mgr: ReturnType<typeof createTabManager<TestTab>>): void {
	mgr._addTab(makeTab("__parked"));
}

describe("createTabManager", () => {
	let mgr: ReturnType<typeof createTabManager<TestTab>>;

	beforeEach(() => {
		// Each test gets a fresh manager (no module-level singleton in tabManager.ts)
		mgr = createTabManager<TestTab>();
	});

	describe("_addTab / _nextId", () => {
		it("adds a tab and sets it active", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				expect(mgr.get("t1")).toBeDefined();
				expect(mgr.state.activeId).toBe("t1");
			});
		});

		it("_nextId returns incrementing ids with prefix", () => {
			testInScope(() => {
				const id1 = mgr._nextId("diff");
				const id2 = mgr._nextId("diff");
				expect(id1).toBe("diff-1");
				expect(id2).toBe("diff-2");
			});
		});
	});

	describe("remove()", () => {
		it("removes a tab by id", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				mgr._addTab(makeTab("t2"));
				mgr.remove("t1");
				expect(mgr.get("t1")).toBeUndefined();
				expect(mgr.get("t2")).toBeDefined();
			});
		});

		it("sets activeId to null when active tab is removed (caller selects the replacement)", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				mgr._addTab(makeTab("t2"));
				expect(mgr.state.activeId).toBe("t2");
				mgr.remove("t2");
				// No auto-promotion: the store can't check branch/repo visibility, so
				// promoting a remaining tab could activate one hidden from the tab bar
				// (ghost full-screen panel). Same contract as terminalsStore.remove.
				expect(mgr.state.activeId).toBeNull();
			});
		});

		it("does not promote a branch-scoped tab hidden from the current branch", () => {
			testInScope(() => {
				mgr._addTab(makeTab("hidden", { branchKey: "/other-repo|main" }));
				mgr._addTab(makeTab("visible", { branchKey: "/repo|main" }));
				expect(mgr.state.activeId).toBe("visible");
				mgr.remove("visible");
				expect(mgr.state.activeId).toBeNull();
				expect(mgr.getVisibleIds("/repo|main")).toEqual([]);
			});
		});

		it("sets activeId to null when last tab is removed", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				mgr.remove("t1");
				expect(mgr.state.activeId).toBeNull();
			});
		});

		it("does not change activeId when a non-active tab is removed", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				mgr._addTab(makeTab("t2"));
				mgr.setActive("t1");
				mgr.remove("t2");
				expect(mgr.state.activeId).toBe("t1");
			});
		});
	});

	describe("getVisibleIds()", () => {
		it("pinned tabs are always visible regardless of branch", () => {
			testInScope(() => {
				mgr._addTab(makeTab("pinned", { pinned: true, branchKey: "/repo|main" }));
				mgr._addTab(makeTab("other", { branchKey: "/repo|feature" }));

				const visible = mgr.getVisibleIds("/repo|feature");
				expect(visible).toContain("pinned");
			});
		});

		it("unscoped tabs (no branchKey) are always visible", () => {
			testInScope(() => {
				mgr._addTab(makeTab("global")); // no branchKey, no pinned
				mgr._addTab(makeTab("branch-scoped", { branchKey: "/repo|feature" }));
				parkActive(mgr);

				const visible = mgr.getVisibleIds("/repo|main");
				expect(visible).toContain("global");
				expect(visible).not.toContain("branch-scoped");
			});
		});

		it("branch-scoped tabs are visible only in their branch", () => {
			testInScope(() => {
				mgr._addTab(makeTab("in-main", { branchKey: "/repo|main" }));
				mgr._addTab(makeTab("in-feature", { branchKey: "/repo|feature" }));
				parkActive(mgr);

				const visibleInMain = mgr.getVisibleIds("/repo|main");
				expect(visibleInMain).toContain("in-main");
				expect(visibleInMain).not.toContain("in-feature");

				const visibleInFeature = mgr.getVisibleIds("/repo|feature");
				expect(visibleInFeature).toContain("in-feature");
				expect(visibleInFeature).not.toContain("in-main");
			});
		});

		it("returns empty array when no tabs exist", () => {
			testInScope(() => {
				expect(mgr.getVisibleIds("/repo|main")).toEqual([]);
			});
		});

		it("returns all unscoped and pinned tabs when branchKey is null", () => {
			testInScope(() => {
				mgr._addTab(makeTab("global")); // unscoped
				mgr._addTab(makeTab("pinned", { pinned: true }));
				mgr._addTab(makeTab("scoped", { branchKey: "/repo|main" }));
				parkActive(mgr);

				const visible = mgr.getVisibleIds(null);
				expect(visible).toContain("global");
				expect(visible).toContain("pinned");
				expect(visible).not.toContain("scoped");
			});
		});

		it("repo-scoped pinned tab is visible only in matching repo", () => {
			testInScope(() => {
				mgr._addTab(makeTab("plan-repo1", { pinned: true, repoPath: "/repo1" }));
				mgr._addTab(makeTab("plan-repo2", { pinned: true, repoPath: "/repo2" }));
				mgr._addTab(makeTab("global-pinned", { pinned: true })); // no repoPath

				const visibleInRepo1 = mgr.getVisibleIds("/repo1|main");
				expect(visibleInRepo1).toContain("plan-repo1");
				expect(visibleInRepo1).not.toContain("plan-repo2");
				expect(visibleInRepo1).toContain("global-pinned");

				const visibleInRepo2 = mgr.getVisibleIds("/repo2|feature");
				expect(visibleInRepo2).not.toContain("plan-repo1");
				expect(visibleInRepo2).toContain("plan-repo2");
				expect(visibleInRepo2).toContain("global-pinned");
			});
		});

		it("repo-scoped tab is hidden when branchKey is null", () => {
			testInScope(() => {
				mgr._addTab(makeTab("repo-scoped", { pinned: true, repoPath: "/repo1" }));
				parkActive(mgr);

				const visible = mgr.getVisibleIds(null);
				expect(visible).not.toContain("repo-scoped");
			});
		});

		/**
		 * The pane renders whatever `activeId` points at, so a hidden active tab is
		 * content with no tab to close it, switch from, or even name — the "ghost
		 * full-screen panel" that `remove()` already refuses to create by promotion.
		 *
		 * `_addTab` opens that hole from the other side: it activates unconditionally,
		 * so opening a file that belongs to another repo (clicking an absolute path an
		 * agent printed) filed the tab under the owning repo — correct — and the repo
		 * gate then hid it while the pane kept drawing it.
		 */
		it("keeps the active tab visible even when its repo is not the current one", () => {
			testInScope(() => {
				mgr._addTab(makeTab("in-repo1", { repoPath: "/repo1", branchKey: "/repo1|main" }));
				mgr._addTab(makeTab("from-repo2", { repoPath: "/repo2", branchKey: "/repo2|feature" }));
				expect(mgr.state.activeId).toBe("from-repo2");

				const visible = mgr.getVisibleIds("/repo1|main");
				expect(visible).toContain("from-repo2");
				expect(visible).toContain("in-repo1");
			});
		});

		it("can check whether an active tab really belongs to the current repo", () => {
			testInScope(() => {
				mgr._addTab(makeTab("foreign", { repoPath: "/repo2", branchKey: "/repo2|main" }));
				expect(mgr.getVisibleIds("/repo1|main", false)).not.toContain("foreign");
				expect(mgr.getVisibleIds("/repo2|main", false)).toContain("foreign");
			});
		});

		it("hides that same foreign tab again once it stops being active", () => {
			testInScope(() => {
				mgr._addTab(makeTab("in-repo1", { repoPath: "/repo1", branchKey: "/repo1|main" }));
				mgr._addTab(makeTab("from-repo2", { repoPath: "/repo2", branchKey: "/repo2|feature" }));
				mgr.setActive("in-repo1");

				expect(mgr.getVisibleIds("/repo1|main")).not.toContain("from-repo2");
			});
		});

		// The exemption is about the tab the user is looking at, not about foreign
		// tabs in general — otherwise every repo's tabs would leak into every bar.
		it("does not exempt non-active tabs from another repo", () => {
			testInScope(() => {
				mgr._addTab(makeTab("a", { repoPath: "/repo2", branchKey: "/repo2|feature" }));
				mgr._addTab(makeTab("b", { repoPath: "/repo2", branchKey: "/repo2|feature" }));
				mgr._addTab(makeTab("here", { repoPath: "/repo1", branchKey: "/repo1|main" }));

				const visible = mgr.getVisibleIds("/repo1|main");
				expect(visible).not.toContain("a");
				expect(visible).not.toContain("b");
				expect(visible).toContain("here");
			});
		});
	});

	describe("setPinned()", () => {
		it("sets a tab as pinned", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1", { branchKey: "/repo|main" }));
				mgr.setPinned("t1", true);
				expect(mgr.get("t1")!.pinned).toBe(true);
			});
		});

		it("unpins a pinned tab", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1", { pinned: true }));
				mgr.setPinned("t1", false);
				expect(mgr.get("t1")!.pinned).toBe(false);
			});
		});

		it("does nothing for an unknown tab id", () => {
			testInScope(() => {
				// Should not throw
				expect(() => mgr.setPinned("nonexistent", true)).not.toThrow();
			});
		});
	});

	describe("clearAll()", () => {
		it("removes all tabs and clears activeId", () => {
			testInScope(() => {
				mgr._addTab(makeTab("t1"));
				mgr._addTab(makeTab("t2"));
				mgr.clearAll();
				expect(mgr.getCount()).toBe(0);
				expect(mgr.state.activeId).toBeNull();
			});
		});

		it("preserves counter after clearAll", () => {
			testInScope(() => {
				mgr._nextId("x"); // counter = 1
				mgr.clearAll();
				const next = mgr._nextId("x");
				expect(next).toBe("x-2"); // counter continues from 2
			});
		});
	});

	describe("getIds / getCount / getActive", () => {
		it("getIds returns all tab ids", () => {
			testInScope(() => {
				mgr._addTab(makeTab("a"));
				mgr._addTab(makeTab("b"));
				expect(mgr.getIds()).toEqual(expect.arrayContaining(["a", "b"]));
				expect(mgr.getIds()).toHaveLength(2);
			});
		});

		it("getCount returns correct count", () => {
			testInScope(() => {
				expect(mgr.getCount()).toBe(0);
				mgr._addTab(makeTab("a"));
				expect(mgr.getCount()).toBe(1);
			});
		});

		it("getActive returns the active tab", () => {
			testInScope(() => {
				mgr._addTab(makeTab("a"));
				mgr._addTab(makeTab("b"));
				mgr.setActive("a");
				expect(mgr.getActive()?.id).toBe("a");
			});
		});

		it("getActive returns undefined when no active tab", () => {
			testInScope(() => {
				expect(mgr.getActive()).toBeUndefined();
			});
		});
	});

	describe("makeBranchKey()", () => {
		it("combines repoPath and branchName with pipe separator", () => {
			expect(makeBranchKey("/repo/path", "main")).toBe("/repo/path|main");
		});

		it("handles branches with slashes", () => {
			expect(makeBranchKey("/repo", "feature/my-feature")).toBe("/repo|feature/my-feature");
		});
	});
});
