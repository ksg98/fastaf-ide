import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(() => Promise.resolve(null)),
}));

import { makeTerminal, testInScope } from "../helpers/store";

/**
 * Per-repo consolidation (#e767). Boss picked one workspace per repo over an
 * exclusive toggle: enabling it on repo B must not cost repo A its layout.
 *
 * The hand-promoted workspace keeps its own scope and must behave exactly as
 * before — it is a separate feature that happens to share the machinery.
 */
describe("globalWorkspaceStore scopes", () => {
	let store: typeof import("../../stores/globalWorkspace").globalWorkspaceStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.resetModules();
		store = (await import("../../stores/globalWorkspace")).globalWorkspaceStore;
		const paneLayout = await import("../../stores/paneLayout");
		paneLayout.resetGroupCounter();
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
	});

	it("defaults to the manual scope so existing behaviour is untouched", () => {
		testInScope(() => {
			const term = terminalsStore.add(makeTerminal({ name: "manual" }));
			store.promote(term);
			expect(store.getScope()).toBe("__manual__");
			expect(store.getPromotedIds()).toEqual([term]);
		});
	});

	it("keeps each repo's members separate from the manual workspace", () => {
		testInScope(() => {
			const manual = terminalsStore.add(makeTerminal({ name: "manual" }));
			store.promote(manual);

			store.syncScopeMembers("/repo/a", ["a-1", "a-2"]);

			// Reading a scope must not disturb the current one.
			expect(store.getScope()).toBe("__manual__");
			expect(store.getPromotedIds()).toEqual([manual]);
			expect(store.getScopeMembers("/repo/a").sort()).toEqual(["a-1", "a-2"]);
		});
	});

	it("does not make two consolidated repos fight for the same space", () => {
		testInScope(() => {
			store.syncScopeMembers("/repo/a", ["a-1"]);
			store.syncScopeMembers("/repo/b", ["b-1"]);

			// The rejected alternative was an exclusive toggle, where enabling B
			// emptied A. Both must survive.
			expect(store.getScopeMembers("/repo/a")).toEqual(["a-1"]);
			expect(store.getScopeMembers("/repo/b")).toEqual(["b-1"]);
		});
	});

	it("adds newly created worktree terminals and drops removed ones", () => {
		testInScope(() => {
			store.syncScopeMembers("/repo/a", ["a-1", "a-2"]);

			// A new worktree appears…
			store.syncScopeMembers("/repo/a", ["a-1", "a-2", "a-3"]);
			expect(store.getScopeMembers("/repo/a").sort()).toEqual(["a-1", "a-2", "a-3"]);

			// …and one is archived.
			store.syncScopeMembers("/repo/a", ["a-1", "a-3"]);
			expect(store.getScopeMembers("/repo/a").sort()).toEqual(["a-1", "a-3"]);
		});
	});

	it("is idempotent: re-syncing the same members changes nothing", () => {
		testInScope(() => {
			store.syncScopeMembers("/repo/a", ["a-1", "a-2"]);
			const before = JSON.stringify(store.getScopeLayout("/repo/a"));

			store.syncScopeMembers("/repo/a", ["a-2", "a-1"]);

			expect(JSON.stringify(store.getScopeLayout("/repo/a"))).toBe(before);
		});
	});

	it("switches the visible layout when the scope changes", () => {
		testInScope(() => {
			const manual = terminalsStore.add(makeTerminal({ name: "manual" }));
			store.promote(manual);
			store.syncScopeMembers("/repo/a", ["a-1"]);

			store.setScope("/repo/a");
			expect(store.getScope()).toBe("/repo/a");
			expect(store.getPromotedIds()).toEqual(["a-1"]);

			store.setScope("__manual__");
			expect(store.getPromotedIds()).toEqual([manual]);
		});
	});

	it("forgets a closed terminal in whichever scope holds it", () => {
		testInScope(() => {
			// Real terminals here: this path runs through terminalsStore.onRemove,
			// and the scope holding the terminal is deliberately NOT the visible one.
			const first = terminalsStore.add(makeTerminal({ name: "wt-1" }));
			const second = terminalsStore.add(makeTerminal({ name: "wt-2" }));
			store.syncScopeMembers("/repo/a", [first, second]);

			terminalsStore.remove(first);

			expect(store.getScopeMembers("/repo/a")).toEqual([second]);
		});
	});
});
