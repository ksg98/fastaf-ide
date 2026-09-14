import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal, testInScope } from "../helpers/store";

/**
 * TerminalArea renders terminals, diffs, markdown and editors as four independent
 * `For` lists, each marking its pane `active` from its OWN store's activeId. When
 * two stores hold an activeId, two panes render on top of each other — Boss hit
 * this by pressing Edit on an open .md, which showed the viewer through the editor.
 *
 * Every call site used to be responsible for nulling the other three stores by
 * hand, and the ones that forgot were the bug. These tests pin the invariant where
 * it now lives: the store that activates a tab deactivates the rest.
 *
 * This replaces `useTabActivationSync`, which enforced the same rule from four
 * `on(activeId, …, { defer: true })` effects. An effect keyed on a CHANGE cannot
 * enforce an invariant that has to hold on every activation REQUEST: re-activating
 * a tab that is already this store's activeId is a no-op write, no effect fires,
 * and whatever else was active stayed on screen. Enforcing inside setActive/_addTab
 * makes it unconditional and synchronous — the pane is correct before the next
 * render, not one effect-flush later.
 */
describe("pane activation is exclusive across stores", () => {
	let terminals: typeof import("../../stores/terminals").terminalsStore;
	let editors: typeof import("../../stores/editorTabs").editorTabsStore;
	let mds: typeof import("../../stores/mdTabs").mdTabsStore;
	let diffs: typeof import("../../stores/diffTabs").diffTabsStore;

	beforeEach(async () => {
		vi.resetModules();
		localStorage.clear();
		// Import order matters only in that every store must be loaded for its
		// deactivator to be registered — which is exactly what the app does.
		terminals = (await import("../../stores/terminals")).terminalsStore;
		editors = (await import("../../stores/editorTabs")).editorTabsStore;
		mds = (await import("../../stores/mdTabs")).mdTabsStore;
		diffs = (await import("../../stores/diffTabs")).diffTabsStore;
	});

	afterEach(() => {
		terminals._testCancelPendingTimers();
	});

	/** Put every store in the active state, so each test proves a real transition. */
	function activateEverything(): string {
		const termId = terminals.add(makeTerminal());
		mds.add("/repo", "README.md");
		diffs.add("/repo", "src/main.ts", "M");
		terminals.setActive(termId);
		return termId;
	}

	it("opening an editor tab leaves ONLY the editor pane active", () => {
		testInScope(() => {
			activateEverything();

			const editId = editors.add("/repo", "src/main.ts");

			expect(editors.state.activeId).toBe(editId);
			expect(mds.state.activeId).toBeNull();
			expect(diffs.state.activeId).toBeNull();
			expect(terminals.state.activeId).toBeNull();
		});
	});

	/** The reported repro: Edit on an already-open markdown file. The editor tab is
	 *  new, but the markdown viewer for the same file is open AND active. */
	it("pressing Edit on an open markdown file hides the viewer", () => {
		testInScope(() => {
			const mdId = mds.add("/repo", "README.md");
			expect(mds.state.activeId).toBe(mdId);

			editors.add("/repo", "README.md");

			expect(mds.state.activeId).toBeNull();
			expect(editors.state.activeId).not.toBeNull();
		});
	});

	/** Re-opening an ALREADY OPEN editor tab takes the dedup branch, which returns
	 *  early — it must still deactivate the other panes. */
	it("re-activating an existing editor tab is just as exclusive", () => {
		testInScope(() => {
			const editId = editors.add("/repo", "src/main.ts");
			mds.add("/repo", "README.md");
			expect(mds.state.activeId).not.toBeNull();

			expect(editors.add("/repo", "src/main.ts")).toBe(editId);

			expect(editors.state.activeId).toBe(editId);
			expect(mds.state.activeId).toBeNull();
		});
	});

	it("activating a tab from the tab bar is exclusive too", () => {
		testInScope(() => {
			const editId = editors.add("/repo", "src/main.ts");
			const mdId = mds.add("/repo", "README.md");
			expect(editors.state.activeId).toBeNull();

			// What a click on the editor tab in the tab bar does.
			editors.setActive(editId);

			expect(editors.state.activeId).toBe(editId);
			expect(mds.state.activeId).toBeNull();
			expect(mds.get(mdId)).toBeDefined();
		});
	});

	it("opening a diff or markdown tab hides the editor", () => {
		testInScope(() => {
			editors.add("/repo", "src/main.ts");
			diffs.add("/repo", "src/main.ts", "M");
			expect(editors.state.activeId).toBeNull();

			editors.add("/repo", "src/main.ts");
			mds.add("/repo", "README.md");
			expect(editors.state.activeId).toBeNull();
			expect(diffs.state.activeId).toBeNull();
		});
	});

	it("focusing a terminal hides every file pane", () => {
		testInScope(() => {
			const termId = terminals.add(makeTerminal());
			editors.add("/repo", "src/main.ts");
			expect(terminals.state.activeId).toBeNull();

			terminals.setActive(termId);

			expect(terminals.state.activeId).toBe(termId);
			expect(editors.state.activeId).toBeNull();
			expect(mds.state.activeId).toBeNull();
			expect(diffs.state.activeId).toBeNull();
		});
	});

	/** Re-activating the tab that is ALREADY active writes the same value, so a
	 *  change-keyed effect would never run. Enforcement must not depend on the
	 *  activeId actually moving. */
	it("re-activating the already-active tab still enforces the invariant", () => {
		testInScope(() => {
			const editId = editors.add("/repo", "src/main.ts");
			expect(editors.state.activeId).toBe(editId);

			editors.setActive(editId);

			expect(editors.state.activeId).toBe(editId);
			expect(mds.state.activeId).toBeNull();
			expect(diffs.state.activeId).toBeNull();
			expect(terminals.state.activeId).toBeNull();
		});
	});

	/** Deactivation must stay local: clearing one store's activeId (branch switch,
	 *  tab close) must not disturb whatever else is showing. */
	it("setActive(null) only clears its own store", () => {
		testInScope(() => {
			const editId = editors.add("/repo", "src/main.ts");
			mds.setActive(null);
			expect(editors.state.activeId).toBe(editId);
		});
	});

	/** Background opens deliberately leave the current pane showing — a plugin
	 *  pre-loading a tab must not yank the user out of their terminal. */
	it("background tab opens do not steal the active pane", () => {
		testInScope(() => {
			const termId = terminals.add(makeTerminal());
			terminals.setActive(termId);

			mds.addFileBackground("/repo", "NOTES.md");
			mds.addVirtualBackground("Virtual", "tuic://virtual/1");

			expect(terminals.state.activeId).toBe(termId);
			expect(mds.state.activeId).toBeNull();
		});
	});
});
