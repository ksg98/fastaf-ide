import { EditorView } from "@codemirror/view";

/** Move an open editor to a one-based file position without replacing its document. */
export function navigateEditorTo(view: EditorView, lineNumber: number, columnNumber = 1): void {
	const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, view.state.doc.lines)));
	const position = Math.min(line.to, line.from + Math.max(0, columnNumber - 1));
	view.dispatch({
		selection: { anchor: position },
		effects: EditorView.scrollIntoView(position, { y: "center" }),
	});
}
