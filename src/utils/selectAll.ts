import { EditorView } from "@codemirror/view";

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
 * Returns false when nothing could be selected, so callers can fall back.
 */
export function selectAllInFocused(): boolean {
	const active = document.activeElement as HTMLElement | null;
	if (!active) return false;

	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
		active.select();
		return true;
	}

	const host = active.closest(".cm-editor");
	const view = host instanceof HTMLElement ? EditorView.findFromDOM(host) : null;
	if (view) {
		view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
		view.focus();
		return true;
	}

	// Any other editable or plain region: the DOM selection is the whole story.
	const target = active.isContentEditable ? active : null;
	if (target) {
		const range = document.createRange();
		range.selectNodeContents(target);
		const sel = window.getSelection();
		if (!sel) return false;
		sel.removeAllRanges();
		sel.addRange(range);
		return true;
	}

	return false;
}
