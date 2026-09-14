import { afterEach, describe, expect, it } from "vitest";
import "../mocks/tauri";
import { branchSwitcherStore } from "../../stores/branchSwitcher";
import { commandPaletteStore } from "../../stores/commandPalette";
import { worktreeManagerStore } from "../../stores/worktreeManager";

/**
 * Regression guard for `TypeError: this.open is not a function`.
 *
 * `useAppShortcutHandlers` copies store methods into the `ShortcutHandlers`
 * object as BARE references (`toggleCommandPalette: commandPaletteStore.toggle`),
 * and `useKeyboardShortcuts` then invokes them as `handlers.toggleCommandPalette()`.
 * At that point `this` is the handlers object, not the store — so any store method
 * that reaches a sibling through `this` blows up the moment the shortcut is pressed.
 * `actionRegistry` detaches the same references one step further, where `this` is
 * `undefined` under ESM strict mode.
 *
 * These tests call the methods the way those two call sites do, not the way a
 * well-behaved caller would.
 */
describe("store methods survive being detached from the store object", () => {
	afterEach(() => {
		commandPaletteStore.close();
		branchSwitcherStore.close();
		worktreeManagerStore.close();
	});

	/** Mirrors useAppShortcutHandlers.ts:134-137 — bare refs in a foreign object. */
	function makeShortcutHandlers() {
		return {
			toggleCommandPalette: commandPaletteStore.toggle,
			toggleWorktreeManager: worktreeManagerStore.toggle,
			toggleBranchSwitcher: branchSwitcherStore.toggle,
			setQuery: commandPaletteStore.setQuery,
			setContentAllRepos: commandPaletteStore.setContentAllRepos,
			openWithQuery: commandPaletteStore.openWithQuery,
			mode: commandPaletteStore.mode,
			searchQuery: commandPaletteStore.searchQuery,
		};
	}

	describe("invoked as a method of the handlers object (useKeyboardShortcuts.ts:270)", () => {
		it("toggleCommandPalette() opens then closes the palette", () => {
			const handlers = makeShortcutHandlers();
			handlers.toggleCommandPalette();
			expect(commandPaletteStore.state.isOpen).toBe(true);
			handlers.toggleCommandPalette();
			expect(commandPaletteStore.state.isOpen).toBe(false);
		});

		it("toggleWorktreeManager() opens then closes the worktree manager", () => {
			const handlers = makeShortcutHandlers();
			handlers.toggleWorktreeManager();
			expect(worktreeManagerStore.state.isOpen).toBe(true);
			handlers.toggleWorktreeManager();
			expect(worktreeManagerStore.state.isOpen).toBe(false);
		});

		it("toggleBranchSwitcher() opens then closes the branch switcher", () => {
			const handlers = makeShortcutHandlers();
			handlers.toggleBranchSwitcher();
			expect(branchSwitcherStore.state.isOpen).toBe(true);
			handlers.toggleBranchSwitcher();
			expect(branchSwitcherStore.state.isOpen).toBe(false);
		});

		it("setQuery() still derives the palette mode", () => {
			const handlers = makeShortcutHandlers();
			handlers.setQuery("~ boom");
			expect(commandPaletteStore.state.query).toBe("~ boom");
			expect(commandPaletteStore.mode()).toBe("terminal");
		});

		it("openWithQuery() opens the palette in the pre-filled mode", () => {
			const handlers = makeShortcutHandlers();
			handlers.openWithQuery("? ");
			expect(commandPaletteStore.state.isOpen).toBe(true);
			expect(commandPaletteStore.mode()).toBe("content");
		});

		it("setContentAllRepos() flips the flag outside content mode", () => {
			const handlers = makeShortcutHandlers();
			commandPaletteStore.setQuery("");
			handlers.setContentAllRepos(true);
			expect(commandPaletteStore.state.contentAllRepos).toBe(true);
			handlers.setContentAllRepos(false);
			expect(commandPaletteStore.state.contentAllRepos).toBe(false);
		});
	});

	describe("invoked fully detached, `this` === undefined (actionRegistry.ts:147)", () => {
		it("toggle references dispatched as plain functions still work", () => {
			const { toggleCommandPalette, toggleWorktreeManager, toggleBranchSwitcher } = makeShortcutHandlers();
			toggleCommandPalette();
			toggleWorktreeManager();
			toggleBranchSwitcher();
			expect(commandPaletteStore.state.isOpen).toBe(true);
			expect(worktreeManagerStore.state.isOpen).toBe(true);
			expect(branchSwitcherStore.state.isOpen).toBe(true);
		});

		it("mode() and searchQuery() read the store, not the caller", () => {
			commandPaletteStore.setQuery("! readme");
			const { mode, searchQuery } = makeShortcutHandlers();
			expect(mode()).toBe("filename");
			expect(searchQuery()).toBe("readme");
		});
	});
});
