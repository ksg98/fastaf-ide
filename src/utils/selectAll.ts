/**
 * Select all content in whatever currently has focus.
 *
 * macOS's own `selectAll:` (what `PredefinedMenuItem::select_all` installs) is a
 * DOM-level selection, and CodeMirror keeps the document in a rope while
 * rendering only the viewport — so the native command could never reach past the
 * lines that happened to be on screen. That is the whole "Cmd+A only selects a
 * subsection" report: the longer the file, the smaller the fraction selected.
 *
 * Routing through here instead lets CodeMirror select its full document via its
 * own state, and leaves every other target on the ordinary DOM behaviour.
 *
 * CodeMirror is imported dynamically on purpose: it ships in a lazy chunk that
 * only loads with an editor tab, and a static import here would pull the whole
 * editor into the initial bundle — which the frontend budget check rejects. By
 * the time this branch can be reached the chunk is already resolved, so the
 * await costs nothing.
 */
export interface SelectAllHooks {
	/** Select the whole terminal buffer. Supplied by the caller so this module stays
	 *  free of store imports; returns false when there is nothing to select. */
	selectAllInTerminal?: () => Promise<boolean> | boolean;
}

export async function selectAllInFocused(hooks: SelectAllHooks = {}): Promise<boolean> {
	const active = document.activeElement as HTMLElement | null;
	if (!active) return false;

	// The terminal must be tested before the input branch below: keyboard input is
	// routed through a hidden <input> parked over the canvas, so `active.select()`
	// would "succeed" on an off-screen one-character buffer and ⌘A would look dead.
	// The buffer itself is canvas-rendered and has no DOM text at all, so only the
	// terminal's own selection model can answer this.
	if (active.closest('[data-focus-target="terminal"]')) {
		return hooks.selectAllInTerminal ? await hooks.selectAllInTerminal() : false;
	}

	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
		active.select();
		return true;
	}

	const host = active.closest(".cm-editor");
	if (host instanceof HTMLElement) {
		const view = await findEditorView(host);
		if (view) {
			view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
			view.focus();
			return true;
		}
		// Deliberately no DOM fallback here: a range over `.cm-content` covers only
		// the rendered viewport, which is the partial selection this function exists
		// to avoid. Selecting nothing is the honest outcome.
		return false;
	}

	// Any other editable region: the DOM selection is the whole story.
	if (active.isContentEditable) return selectNodeContents(active);

	// Read-only rendered content — the markdown preview above all, whose focus sits
	// on a plain wrapper div that is neither editable nor an editor. Nothing below
	// the input branches used to match it, so ⌘A did nothing at all there: the menu
	// item is custom, so declining to handle it does not fall back to the native
	// `selectAll:` either. Panels opt in by marking the region worth selecting; the
	// scope excludes the tab header, so ⌘A does not sweep up the filename and
	// toolbar buttons along with the document.
	const scope = active.closest<HTMLElement>("[data-select-all-scope]") ?? findScopeWithin(active);
	if (scope) return selectNodeContents(scope);

	return false;
}

/** The single select-all scope inside `root`, when it has exactly one — a focused
 *  panel wrapper holds its content region as a descendant, not an ancestor. */
function findScopeWithin(root: HTMLElement): HTMLElement | null {
	const found = root.querySelectorAll<HTMLElement>("[data-select-all-scope]");
	return found.length === 1 ? found[0] : null;
}

function selectNodeContents(el: HTMLElement): boolean {
	const sel = window.getSelection();
	if (!sel) return false;
	const range = document.createRange();
	range.selectNodeContents(el);
	sel.removeAllRanges();
	sel.addRange(range);
	return true;
}

/** Resolve the EditorView behind a `.cm-editor` host. Split out so the copy path
 *  can reuse it, and so the dynamic import stays in one place. */
async function findEditorView(host: HTMLElement) {
	const { EditorView } = await import("@codemirror/view");
	return EditorView.findFromDOM(host);
}

/**
 * The text currently selected in the focused editor, read from CodeMirror's
 * document rather than the DOM.
 *
 * Returns `null` when focus is not inside an editor, so callers can fall back to
 * their own surface, and `""` when an editor is focused with nothing selected.
 *
 * This is the other half of the ⌘A story: ⌘A selects the whole document through
 * `selectAllInFocused`, but a copy that reads `window.getSelection()` sees only
 * the lines CodeMirror has rendered — so copying after select-all yielded just
 * the viewport, and yielded *more* after scrolling. Reading the state keeps the
 * two consistent for files of any size.
 */
export async function selectedTextInFocusedEditor(): Promise<string | null> {
	const active = document.activeElement as HTMLElement | null;
	const host = active?.closest(".cm-editor");
	if (!(host instanceof HTMLElement)) return null;

	const view = await findEditorView(host);
	if (!view) return null;

	return view.state.selection.ranges
		.filter((range) => !range.empty)
		.map((range) => view.state.sliceDoc(range.from, range.to))
		.join("\n");
}
