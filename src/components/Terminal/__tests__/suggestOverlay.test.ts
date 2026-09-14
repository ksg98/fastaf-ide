import { describe, expect, it } from "vitest";
import { continuationRowsAfterSuggest, isSuggestBlock, planSuggestOverlay, type RowSnapshot } from "../suggestOverlay";

/** Build a `getRow` lookup from a compact string/bool list, with null past end. */
function rows(snapshots: Array<[string, boolean]>): (i: number) => RowSnapshot | null {
	return (i) => {
		if (i < 0 || i >= snapshots.length) return null;
		const [text, isWrapped] = snapshots[i];
		return { text, isWrapped };
	};
}

describe("continuationRowsAfterSuggest", () => {
	it("returns [] for a single-line bracketed suggest (closes on the anchor)", () => {
		const get = rows([
			["suggest: [ A | B | C ]", false], // anchor closes here
			["bash: some unrelated next line", false],
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("does not swallow trailing pipe content after a closed single-line suggest", () => {
		// The `]` bounds the token; a following mermaid/table pipe row is ignored.
		const get = rows([
			["suggest: [ A | B | C ]", false], // closed
			["software_product ||--o{ software_signature | product_id", false], // mermaid — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("hides wrapped continuation rows up to and including the closing ] row", () => {
		const get = rows([
			["suggest: [ 1) very long first item that wraps | 2) second", false], // anchor, no ]
			[" item also long | 3) third item that keeps going", true], // wrapped
			[" onto another row ]", true], // closing ] here
			["bash$ ", false], // after ] — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 4, get)).toEqual([1, 2]);
	});

	it("hides a non-wrapped tail row carrying the closing ]", () => {
		const get = rows([
			["suggest: [ A | B |", false], // anchor, open
			["C ]", false], // tail with closing ]
			["unrelated next row |", false], // after ] — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 3, get)).toEqual([1]);
	});

	it("stops at a new suggest anchor before the ] arrives", () => {
		const get = rows([
			["suggest: [ A | B", false], // anchor, unclosed
			["suggest: [ X | Y | Z ]", false], // new suggest — stop before it
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("stops at a new intent token before the ] arrives", () => {
		const get = rows([
			["suggest: [ A | B", false], // anchor, unclosed
			["intent: doing something new", false], // new intent — stop
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("handles empty buffer past the anchor", () => {
		const get = rows([["suggest: [ A | B ]", false]]);
		expect(continuationRowsAfterSuggest(0, 1, get)).toEqual([]);
	});

	it("stops when getRow returns null (gap in the buffer)", () => {
		const get = (i: number) => {
			if (i === 0) return { text: "suggest: [ A | B", isWrapped: false };
			return null;
		};
		expect(continuationRowsAfterSuggest(0, 5, get)).toEqual([]);
	});
});

describe("isSuggestBlock", () => {
	it("returns true for a bracketed suggest with pipe on the same line", () => {
		const get = rows([["suggest: [ A | B | C ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(true);
	});

	it("returns true when the pipe is on a wrapped continuation row", () => {
		const get = rows([
			["suggest: [ 1) Testa il popup con Shift+Cmd+I su un upstream r", false],
			["eale | 2) Continua con la story (clippy cleanup)", true],
			["| 3) Crea una PR per questi cambiamenti ]", true],
		]);
		expect(isSuggestBlock(0, 3, get)).toBe(true);
	});

	it("returns false for prose starting with suggest: but no bracket", () => {
		const get = rows([
			["suggest: we should refactor the codebase", false],
			["to improve performance and readability", true],
		]);
		expect(isSuggestBlock(0, 2, get)).toBe(false);
	});

	it("returns false for a bracketed suggest with a single item (no pipe)", () => {
		const get = rows([["suggest: [ just one option ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(false);
	});

	it("returns false for a row that does not start with suggest:", () => {
		const get = rows([["I suggest: [ try something | maybe ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(false);
	});

	it("returns true with Ink bullet prefix", () => {
		const get = rows([["● suggest: [ Run tests | Check logs ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(true);
	});

	it("returns false when row is not the anchor index", () => {
		const get = rows([
			["unrelated row", false],
			["suggest: [ A | B ]", false],
		]);
		expect(isSuggestBlock(0, 2, get)).toBe(false);
	});
});

describe("planSuggestOverlay", () => {
	it("names every row the overlay must mask, in order", () => {
		const get = rows([
			["bash: unrelated", false],
			["suggest: [ A |", false],
			["B | C ]", true],
			["intent: doing a thing (Thing)", false],
		]);
		const plan = planSuggestOverlay(4, get);
		expect(plan.blocks).toEqual([
			{ row: 1, kind: "suggest" },
			{ row: 2, kind: "continuation" },
			{ row: 3, kind: "intent" },
		]);
	});

	// The key exists so an unchanged screen skips the DOM rebuild. Computing it
	// from freshly built <div>s defeats the point: the elements are created and
	// dropped on every frame that repaints, which is most of them.
	it("gives identical screens the same key and different screens different keys", () => {
		const screen = (): Array<[string, boolean]> => [
			["suggest: [ A | B | C ]", false],
			["intent: x (X)", false],
		];
		const a = planSuggestOverlay(2, rows(screen()));
		const b = planSuggestOverlay(2, rows(screen()));
		expect(a.key).toBe(b.key);
		expect(a.key).not.toBe("");

		const moved = planSuggestOverlay(
			2,
			rows([
				["other", false],
				["intent: x (X)", false],
			]),
		);
		expect(moved.key).not.toBe(a.key);
	});

	// The highlight pattern is looser than the walk's stop pattern on purpose: an
	// agent prints its intent line behind a bullet, and that row must still be
	// tinted. Using the stop pattern here would silently leave it untinted.
	it("tints an intent line that sits behind a bullet", () => {
		const plan = planSuggestOverlay(1, rows([["\u23fa intent: doing a thing (Thing)", false]]));
		expect(plan.blocks).toEqual([{ row: 0, kind: "intent" }]);
	});

	// ...but the same looseness must NOT end a suggest block early, or the row
	// carrying the closing bracket stops being masked and the raw token shows.
	it("does not let an indented intent mention cut a suggest block short", () => {
		const plan = planSuggestOverlay(
			3,
			rows([
				["suggest: [ A |", false],
				["  intent: mentioned in passing", true],
				["B | C ]", true],
			]),
		);
		expect(plan.blocks).toEqual([
			{ row: 0, kind: "suggest" },
			{ row: 1, kind: "continuation" },
			{ row: 2, kind: "continuation" },
		]);
	});

	it("has an empty key when nothing needs masking", () => {
		expect(
			planSuggestOverlay(
				2,
				rows([
					["ls -la", false],
					["file.txt", false],
				]),
			),
		).toEqual({
			key: "",
			blocks: [],
		});
	});
});
