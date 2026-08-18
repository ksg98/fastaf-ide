import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { selectAllInFocused, selectedTextInFocusedEditor } from "../../utils/selectAll";

/** A real CodeMirror view — the bug being pinned here is precisely that its
 *  document is longer than what it renders, so a mock would prove nothing. */
function mountEditor(doc: string, selection?: { anchor: number; head: number }): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	// The selection is baked into the initial state rather than dispatched:
	// happy-dom fires `selectionchange` synchronously inside the transaction,
	// which re-enters EditorView.update and throws. Nothing under test cares how
	// the selection got there.
	return new EditorView({ state: EditorState.create({ doc, selection }), parent });
}

const LONG_FILE = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");

afterEach(() => {
	document.body.innerHTML = "";
});

describe("selectAllInFocused", () => {
	it("selects the whole document, not just the rendered lines", async () => {
		const view = mountEditor(LONG_FILE);
		view.contentDOM.focus();

		expect(await selectAllInFocused()).toBe(true);
		expect(view.state.selection.main.from).toBe(0);
		expect(view.state.selection.main.to).toBe(view.state.doc.length);

		view.destroy();
	});

	it("selects the value of a focused input", async () => {
		const input = document.createElement("input");
		input.value = "hello";
		document.body.appendChild(input);
		input.focus();

		expect(await selectAllInFocused()).toBe(true);
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe(5);
	});
});

describe("selectedTextInFocusedEditor", () => {
	it("returns null when focus is not in an editor, so callers keep their own surface", async () => {
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		expect(await selectedTextInFocusedEditor()).toBeNull();
	});

	it("returns the full selected text after select-all, beyond the rendered viewport", async () => {
		const view = mountEditor(LONG_FILE, { anchor: 0, head: LONG_FILE.length });
		view.contentDOM.focus();

		const copied = await selectedTextInFocusedEditor();

		// The whole file — this is what ⌘C used to truncate to the visible lines.
		expect(copied).toBe(LONG_FILE);
		expect(copied?.split("\n")).toHaveLength(2000);

		view.destroy();
	});

	it("returns a partial range verbatim, without trimming line ends", async () => {
		const view = mountEditor("alpha   \nbeta\n", { anchor: 0, head: 13 });
		view.contentDOM.focus();

		expect(await selectedTextInFocusedEditor()).toBe("alpha   \nbeta");

		view.destroy();
	});

	it("returns an empty string (not null) when an editor is focused with no selection", async () => {
		const view = mountEditor("alpha\nbeta\n");
		view.contentDOM.focus();

		// Empty, not null: the caller must NOT fall back to a stale terminal selection.
		expect(await selectedTextInFocusedEditor()).toBe("");

		view.destroy();
	});
});
