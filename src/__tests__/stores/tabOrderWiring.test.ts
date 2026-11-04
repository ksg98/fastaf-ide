import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal, testInScope } from "../helpers/store";

/**
 * The cross-kind order list is only useful if the stores keep it populated: with an
 * empty list `reorder` finds neither id and returns, so every drag across tab kinds
 * silently does nothing. These tests drive the real add/close paths, not the primitive.
 */
describe("cross-kind tab order wiring", () => {
	let tabManager: typeof import("../../stores/tabManager");
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;
	let diffTabsStore: typeof import("../../stores/diffTabs").diffTabsStore;

	beforeEach(async () => {
		vi.resetModules();
		localStorage.clear();
		tabManager = await import("../../stores/tabManager");
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		diffTabsStore = (await import("../../stores/diffTabs")).diffTabsStore;
	});

	afterEach(() => {
		terminalsStore._testCancelPendingTimers();
	});

	describe("terminalsStore", () => {
		it("registers a new terminal in the cross-kind order", () => {
			testInScope(() => {
				const a = terminalsStore.add(makeTerminal());
				const b = terminalsStore.add(makeTerminal());
				expect(tabManager.tabOrderingStore.state.order).toEqual([a, b]);
			});
		});

		it("drops a closed terminal from the cross-kind order", () => {
			testInScope(() => {
				const a = terminalsStore.add(makeTerminal());
				const b = terminalsStore.add(makeTerminal());
				terminalsStore.remove(a);
				expect(tabManager.tabOrderingStore.state.order).toEqual([b]);
			});
		});
	});

	describe("createTabManager", () => {
		it("registers foreground and background tabs in the cross-kind order", () => {
			testInScope(() => {
				const mgr = tabManager.createTabManager<{ id: string }>();
				mgr._addTab({ id: "a" });
				mgr._addTabBackground({ id: "b" });
				expect(tabManager.tabOrderingStore.state.order).toEqual(["a", "b"]);
			});
		});

		it("drops a removed tab from the cross-kind order", () => {
			testInScope(() => {
				const mgr = tabManager.createTabManager<{ id: string }>();
				mgr._addTab({ id: "a" });
				mgr._addTab({ id: "b" });
				mgr.remove("a");
				expect(tabManager.tabOrderingStore.state.order).toEqual(["b"]);
			});
		});

		it("drops every tab from the cross-kind order on clearAll", () => {
			testInScope(() => {
				const mgr = tabManager.createTabManager<{ id: string }>();
				mgr._addTab({ id: "a" });
				mgr._addTab({ id: "b" });
				mgr.clearAll();
				expect(tabManager.tabOrderingStore.state.order).toEqual([]);
			});
		});

		it("drops cleared tabs from the cross-kind order on _clearWhere", () => {
			testInScope(() => {
				const one = diffTabsStore.add("/repo1", "a.ts", "M");
				const two = diffTabsStore.add("/repo2", "b.ts", "M");
				diffTabsStore.clearForRepo("/repo1");
				expect(tabManager.tabOrderingStore.state.order).toEqual([two]);
				expect(tabManager.tabOrderingStore.state.order).not.toContain(one);
			});
		});
	});

	describe("reorder across kinds", () => {
		it("moves a diff tab before a terminal tab", () => {
			testInScope(() => {
				const term = terminalsStore.add(makeTerminal());
				const diff = diffTabsStore.add("/repo", "src/main.ts", "M");
				const visible = new Set([term, diff]);
				expect(tabManager.tabOrderingStore.getOrdered(visible)).toEqual([term, diff]);

				tabManager.tabOrderingStore.reorder(diff, term, "before");
				expect(tabManager.tabOrderingStore.getOrdered(visible)).toEqual([diff, term]);
			});
		});

		it("moves a terminal tab after a diff tab", () => {
			testInScope(() => {
				const term = terminalsStore.add(makeTerminal());
				const diff = diffTabsStore.add("/repo", "src/main.ts", "M");

				tabManager.tabOrderingStore.reorder(term, diff, "after");
				expect(tabManager.tabOrderingStore.getOrdered(new Set([term, diff]))).toEqual([diff, term]);
			});
		});

		it("keeps a reordered tab in place when a later tab is opened", () => {
			testInScope(() => {
				const term = terminalsStore.add(makeTerminal());
				const diff = diffTabsStore.add("/repo", "src/main.ts", "M");
				tabManager.tabOrderingStore.reorder(diff, term, "before");

				const late = terminalsStore.add(makeTerminal());
				expect(tabManager.tabOrderingStore.getOrdered(new Set([term, diff, late]))).toEqual([diff, term, late]);
			});
		});
	});
});
