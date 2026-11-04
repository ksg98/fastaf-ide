import { EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { installDocument } from "../../components/CodeEditorPanel/CodeEditorTab";

/** Large enough that a correct viewport is a small fraction of the document. */
const BIG = Array.from({ length: 40000 }, (_, i) => `line ${i}`).join("\n");

const views: EditorView[] = [];

/** One turn of the macrotask queue, which is what happy-dom schedules a frame on. */
function flushFrame(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * A view on an empty document that has measured itself as not visible — the state a
 * tab is in while the "Loading..." placeholder hides the editor host and the file read
 * is still in flight. CodeMirror accepts any viewport in that state, which is what the
 * document install has to work around.
 *
 * happy-dom reports a zero-size rect for every element, so the measure CodeMirror
 * schedules on creation reaches the same conclusion the hidden host produces in a real
 * browser. Waiting a macrotask lets that measure run.
 */
async function mountEmptyView(extensions: readonly StateField<unknown>[] = []): Promise<EditorView> {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({ state: EditorState.create({ doc: "", extensions: [...extensions] }), parent });
	views.push(view);
	await flushFrame();
	expect(view.inView).toBe(false);
	return view;
}

afterEach(async () => {
	// Run the measure every setState schedules, and the frame that measure requests in
	// turn: happy-dom keeps the timer backing a cancelled animation frame alive, so
	// destroying the view is not enough and a pending frame outlives the file as a leak.
	await flushFrame();
	await flushFrame();
	for (const view of views.splice(0)) view.destroy();
	document.body.innerHTML = "";
});

describe("installDocument", () => {
	it("keeps the viewport a fraction of a freshly loaded large document", async () => {
		const view = await mountEmptyView();

		installDocument(view, BIG);

		expect(view.state.doc.toString()).toBe(BIG);
		expect(view.viewport.to).toBeLessThan(BIG.length / 10);
	});

	it("does what a dispatched whole-document replacement cannot", async () => {
		// The bug this helper exists for. mapViewport() carries the empty {0, 0} viewport
		// across the insertion to {0, doc.length}, and viewportIsAppropriate() accepts it
		// because the editor measured as not visible. CodeMirror then renders every line:
		// 720k line elements and a minute-long main-thread block on a 23 MB file.
		const view = await mountEmptyView();

		view.dispatch({ changes: { from: 0, to: 0, insert: BIG } });

		expect(view.viewport.to).toBe(BIG.length);
	});

	it("keeps the extension configuration across the swap", async () => {
		// The reason the new state is derived from the live one instead of being built
		// with EditorState.create: the gutter, the blame field and every compartment
		// solid-codemirror appended live in the configuration.
		const counter = StateField.define<number>({ create: () => 0, update: (value) => value + 1 });
		const view = await mountEmptyView([counter]);

		installDocument(view, BIG);

		expect(view.state.field(counter)).toBe(1);
	});

	it("replaces the previous document instead of appending to it", async () => {
		const view = await mountEmptyView();
		installDocument(view, "first\ndocument");

		installDocument(view, "second");

		expect(view.state.doc.toString()).toBe("second");
	});

	it("leaves the state untouched when the document is already installed", async () => {
		const view = await mountEmptyView();
		installDocument(view, BIG);
		const installed = view.state;

		installDocument(view, BIG);

		expect(view.state).toBe(installed);
	});

	it("installs a document of the same length but different content", async () => {
		// The length check is a shortcut around a 23 MB toString(), not an equality test.
		const view = await mountEmptyView();
		installDocument(view, "aaaa");

		installDocument(view, "bbbb");

		expect(view.state.doc.toString()).toBe("bbbb");
	});
});
