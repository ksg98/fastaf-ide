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
		const { EditorView } = await import("@codemirror/view");
		const view = EditorView.findFromDOM(host);
		if (view) {
			view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
			view.focus();
			return true;
		}
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
