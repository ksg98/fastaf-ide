import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal, testInScope } from "../helpers/store";

/** The `blockFoldingEnabled` setting, mutable per test. The real store cannot be
 * used here: flipping it calls `save()`, which is refused before hydrate and
 * logs an error, so the setting would arrive with unrelated noise attached. */
const { mockSettings } = vi.hoisted(() => ({
	mockSettings: { state: { blockFoldingEnabled: true } },
}));

vi.mock("../../stores/settings", () => ({ settingsStore: mockSettings }));

/** `block-fold-toggle` reaches folding through TWO callers — CanvasTerminal's
 * own Cmd+Shift+. branch and `toggleNearestCommandBlock` behind the global
 * action (shortcut + command palette). They converge on `toggleBlockFold`, so
 * the setting is enforced there and not once per caller: a guard on each branch
 * is one forgotten `if` away from a third caller folding blocks with the
 * feature switched off. These tests are deliberately unsatisfiable by a
 * caller-side check. */
describe("terminalsStore.toggleBlockFold — blockFoldingEnabled gate", () => {
	let store: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.resetModules();
		localStorage.clear();
		mockSettings.state.blockFoldingEnabled = true;
		store = (await import("../../stores/terminals")).terminalsStore;
	});

	it("folds a block when the setting is on", () => {
		testInScope(() => {
			const id = store.add(makeTerminal());
			store.toggleBlockFold(id, 42);
			expect([...store.get(id)!.foldedBlocks]).toEqual([42]);
		});
	});

	it("unfolds an already-folded block when the setting is on", () => {
		testInScope(() => {
			const id = store.add(makeTerminal());
			store.toggleBlockFold(id, 42);
			store.toggleBlockFold(id, 42);
			expect([...store.get(id)!.foldedBlocks]).toEqual([]);
		});
	});

	it("does not fold when the setting is off", () => {
		testInScope(() => {
			const id = store.add(makeTerminal());
			mockSettings.state.blockFoldingEnabled = false;
			store.toggleBlockFold(id, 42);
			expect([...store.get(id)!.foldedBlocks]).toEqual([]);
		});
	});

	it("leaves blocks folded before the setting was turned off alone", () => {
		// Turning the feature off hides the control, not the state: a block the
		// user already collapsed stays collapsed, because silently expanding
		// history on a settings change is a worse surprise than a stuck fold.
		testInScope(() => {
			const id = store.add(makeTerminal());
			store.toggleBlockFold(id, 42);
			mockSettings.state.blockFoldingEnabled = false;
			expect([...store.get(id)!.foldedBlocks]).toEqual([42]);
		});
	});

	it("does not unfold either when the setting is off", () => {
		// The gate is on the transition, not on the fold direction — with the
		// feature off neither half of the toggle may move.
		testInScope(() => {
			const id = store.add(makeTerminal());
			store.toggleBlockFold(id, 42);
			mockSettings.state.blockFoldingEnabled = false;
			store.toggleBlockFold(id, 42);
			expect([...store.get(id)!.foldedBlocks]).toEqual([42]);
		});
	});
});
