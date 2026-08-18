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
export async function selectAllInFocused(): Promise<boolean> {
	const active = document.activeElement as HTMLElement | null;
	if (!active) return false;

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
	if (active.isContentEditable) {
		const range = document.createRange();
		range.selectNodeContents(active);
		const sel = window.getSelection();
		if (!sel) return false;
		sel.removeAllRanges();
		sel.addRange(range);
		return true;
	}

	return false;
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
