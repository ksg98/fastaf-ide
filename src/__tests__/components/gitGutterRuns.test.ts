import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	changesField,
	coalesceChangeRuns,
	type GutterChange,
	replacesWholeDoc,
	setChangesEffect,
} from "../../components/CodeEditorPanel/gitGutter";

const added = (line: number): GutterChange => ({ line, type: "added" });
const modified = (line: number): GutterChange => ({ line, type: "modified" });

describe("coalesceChangeRuns", () => {
	it("collapses a whole-new file (all contiguous additions) to a single tick", () => {
		const changes = Array.from({ length: 50 }, (_, i) => added(i + 1));
		expect(coalesceChangeRuns(changes, 50)).toEqual([{ line: 1, type: "added" }]);
	});

	it("starts a new run on a line gap", () => {
		const changes = [added(1), added(2), added(10), added(11)];
		expect(coalesceChangeRuns(changes, 20)).toEqual([
			{ line: 1, type: "added" },
			{ line: 10, type: "added" },
		]);
	});

	it("starts a new run on a type change even when lines are contiguous", () => {
		const changes = [added(5), added(6), modified(7), modified(8)];
		expect(coalesceChangeRuns(changes, 20)).toEqual([
			{ line: 5, type: "added" },
			{ line: 7, type: "modified" },
		]);
	});

	it("sorts unordered input before coalescing", () => {
		const changes = [added(3), added(1), added(2)];
		expect(coalesceChangeRuns(changes, 10)).toEqual([{ line: 1, type: "added" }]);
	});

	it("returns nothing for no changes", () => {
		expect(coalesceChangeRuns([], 10)).toEqual([]);
	});
});

describe("replacesWholeDoc", () => {
	/** Build the transaction that loading `next` into a document holding `prev` produces. */
	const swap = (prev: string, next: string) => {
		const state = EditorState.create({ doc: prev });
		return state.update({ changes: { from: 0, to: state.doc.length, insert: next } });
	};

	it("is true for the full-document swap that opening another file makes", () => {
		expect(replacesWholeDoc(swap("old file\n", "new file\n"))).toBe(true);
	});

	it("is false for a typed character", () => {
		const state = EditorState.create({ doc: "line1\nline2" });
		expect(replacesWholeDoc(state.update({ changes: { from: 5, insert: "X" } }))).toBe(false);
	});

	it("is false for a transaction that changes no text", () => {
		const state = EditorState.create({ doc: "line1" });
		expect(replacesWholeDoc(state.update({ selection: { anchor: 0 } }))).toBe(false);
	});

	it("drops the previous file's markers inside the swap, with no dispatch of its own", () => {
		const state = EditorState.create({ doc: "old\n", extensions: [changesField] });
		const marked = state.update({ effects: setChangesEffect([added(1)]) }).state;
		expect(marked.field(changesField)).toEqual([added(1)]);
		const swapped = marked.update({ changes: { from: 0, to: marked.doc.length, insert: "a\nb\nc\n" } }).state;
		expect(swapped.field(changesField)).toEqual([]);
	});

	it("keeps the markers through an edit, so the gutter does not blink while typing", () => {
		const state = EditorState.create({ doc: "old\n", extensions: [changesField] });
		const marked = state.update({ effects: setChangesEffect([added(1)]) }).state;
		const typed = marked.update({ changes: { from: 3, insert: "X" } }).state;
		expect(typed.field(changesField)).toEqual([added(1)]);
	});
});
