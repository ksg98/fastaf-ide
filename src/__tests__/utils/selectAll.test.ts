import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("selectAllInFocused: the terminal", () => {
	/** Focus is parked on a hidden <input> over the canvas — the shape that made ⌘A
	 *  silently "succeed" on an off-screen buffer instead of selecting the terminal. */
	function mountTerminal() {
		const wrapper = document.createElement("div");
		wrapper.setAttribute("data-focus-target", "terminal");
		const keyInput = document.createElement("input");
		keyInput.value = "x";
		wrapper.appendChild(keyInput);
		document.body.appendChild(wrapper);
		keyInput.focus();
		return keyInput;
	}

	it("delegates to the terminal instead of selecting the hidden key input", async () => {
		const keyInput = mountTerminal();
		const selectAllInTerminal = vi.fn(async () => true);
		const select = vi.spyOn(keyInput, "select");

		expect(await selectAllInFocused({ selectAllInTerminal })).toBe(true);

		expect(selectAllInTerminal).toHaveBeenCalledOnce();
		expect(select).not.toHaveBeenCalled();
	});

	it("reports the terminal's own answer when it has nothing to select", async () => {
		mountTerminal();
		expect(await selectAllInFocused({ selectAllInTerminal: async () => false })).toBe(false);
	});

	it("does not fall through to the input branch when no hook is supplied", async () => {
		const keyInput = mountTerminal();
		const select = vi.spyOn(keyInput, "select");

		expect(await selectAllInFocused()).toBe(false);
		expect(select).not.toHaveBeenCalled();
	});
});

describe("selectAllInFocused: rendered read-only content", () => {
	/** The markdown tab's shape: focus on a wrapper that also holds the header, with
	 *  the document itself in a marked-up region below it. */
	function mountPreview() {
		const wrapper = document.createElement("div");
		wrapper.tabIndex = -1;
		const header = document.createElement("div");
		header.textContent = "README.md";
		const content = document.createElement("div");
		content.setAttribute("data-select-all-scope", "");
		content.innerHTML = "<h1>Title</h1><p>Body text</p>";
		wrapper.append(header, content);
		document.body.appendChild(wrapper);
		wrapper.focus();
		return { wrapper, content };
	}

	it("selects the document region when focus sits on its wrapper", async () => {
		const { content } = mountPreview();

		expect(await selectAllInFocused()).toBe(true);

		const range = window.getSelection()?.getRangeAt(0);
		expect(range?.commonAncestorContainer).toBe(content);
	});

	it("leaves the header out of the selection", async () => {
		mountPreview();

		await selectAllInFocused();

		const text = window.getSelection()?.toString() ?? "";
		expect(text).toContain("Body text");
		expect(text).not.toContain("README.md");
	});

	it("selects the region when focus is already inside it", async () => {
		const { content } = mountPreview();
		const inner = content.querySelector("p") as HTMLElement;
		inner.tabIndex = -1;
		inner.focus();

		expect(await selectAllInFocused()).toBe(true);
		expect(window.getSelection()?.getRangeAt(0).commonAncestorContainer).toBe(content);
	});

	it("declines when a focused wrapper holds no single unambiguous region", async () => {
		const wrapper = document.createElement("div");
		wrapper.tabIndex = -1;
		for (const _ of [0, 1]) {
			const region = document.createElement("div");
			region.setAttribute("data-select-all-scope", "");
			wrapper.appendChild(region);
		}
		document.body.appendChild(wrapper);
		wrapper.focus();

		expect(await selectAllInFocused()).toBe(false);
	});
});
