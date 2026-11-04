import { describe, expect, it, vi } from "vitest";
import {
	commitSelectionCopy,
	createCanvasSearchController,
	createCanvasSelectionController,
	edgeScrollDistance,
	edgeScrollLines,
	edgeSelectionPoint,
	isSelectionRowsExpiredError,
	selectionRowToGridRow,
	selectionRowToViewport,
	shouldValidateSelectionSnapshot,
	viewportRowToSelectionRow,
} from "../canvasTerminalSelection";
import { readProjectedSelectionText } from "../canvasTerminalText";
import type { DecodedRow } from "../canvasTerminalUtils";

function row(text: string): DecodedRow {
	const codepoints = new Uint32Array([...text].map((character) => character.codePointAt(0) ?? 0));
	return {
		index: 0,
		count: codepoints.length,
		wrapped: false,
		codepoints,
		fg: new Uint32Array(codepoints.length),
		bg: new Uint32Array(codepoints.length),
		attrs: new Uint8Array(codepoints.length),
	};
}

describe("canvas terminal selection controller", () => {
	// catches: backend reads trim trailing newlines per retained run, deleting the
	// one visible separator before a removed suggestion paragraph when runs join.
	it("preserves the visible paragraph separator when backend retained reads trim trailing newlines", async () => {
		const texts = ["answer", "", "suggest: [ A | B | C ]", "", "footer"];
		const rows = new Map(texts.map((text, index) => [index, row(text.padEnd(24, " "))]));
		const text = await readProjectedSelectionText({ row: 0, col: 0 }, { row: 4, col: 5 }, rows, async (start, end) =>
			texts
				.slice(start.row, end.row + 1)
				.join("\n")
				.replace(/\n+$/, ""),
		);
		expect(text).toBe("answer\n\nfooter");
	});

	it("keeps a selected row stable while parked history grows", () => {
		const before = { historyBase: 40, historySize: 100, displayOffset: 50, screenRows: 24 };
		const selectedRow = viewportRowToSelectionRow(before, 7);
		expect(selectedRow).toBe(97);

		const afterOutput = { historyBase: 40, historySize: 101, displayOffset: 51, screenRows: 24 };
		expect(selectionRowToViewport(afterOutput, selectedRow)).toBe(7);
	});

	it("does not alias an evicted selection onto the replacement grid row", () => {
		const selectedRow = viewportRowToSelectionRow(
			{ historyBase: 40, historySize: 100, displayOffset: 100, screenRows: 24 },
			0,
		);
		expect(selectedRow).toBe(40);

		const afterEviction = { historyBase: 41, historySize: 100, displayOffset: 100, screenRows: 24 };
		expect(selectionRowToViewport(afterEviction, selectedRow)).toBeNull();
		expect(selectionRowToGridRow(afterEviction, selectedRow)).toBeNull();
	});

	it("keeps a retained selected row fixed when eviction and parked offset advance together", () => {
		const before = { historyBase: 40, historySize: 100, displayOffset: 50, screenRows: 24 };
		const selectedRow = viewportRowToSelectionRow(before, 7);
		const afterEviction = { historyBase: 41, historySize: 100, displayOffset: 51, screenRows: 24 };

		expect(selectionRowToViewport(afterEviction, selectedRow)).toBe(7);
		expect(selectionRowToGridRow(afterEviction, selectedRow)).toBe(56);
	});

	it("converts a retained stable selection row back to the backend grid coordinate", () => {
		const viewport = { historyBase: 40, historySize: 100, displayOffset: 50, screenRows: 24 };
		expect(selectionRowToGridRow(viewport, 97)).toBe(57);
	});

	it("recognizes the backend rejection for selection rows evicted before the read lock", () => {
		expect(isSelectionRowsExpiredError(new Error("selection rows are no longer retained"))).toBe(true);
		expect(isSelectionRowsExpiredError(new Error("clipboard unavailable"))).toBe(false);
	});

	it("does not write the clipboard when eviction wins the backend selection-read race", async () => {
		const write = vi.fn(async () => {});
		await expect(
			commitSelectionCopy(async () => {
				throw new Error("selection rows are no longer retained");
			}, write),
		).resolves.toEqual({ kind: "expired" });
		expect(write).not.toHaveBeenCalled();
	});

	it("invalidates copied text when a new selection gesture starts", () => {
		const selection = createCanvasSelectionController();
		selection.start = { row: 7, col: 1 };
		selection.end = { row: 7, col: 4 };
		selection.cachedText = "previous range";

		selection.invalidateSnapshot();

		expect(selection.cachedText).toBe("");
		expect(selection.start).toEqual({ row: 7, col: 1 });
		expect(selection.end).toEqual({ row: 7, col: 4 });
	});

	it("validates replacement text only after the selection gesture is complete", () => {
		const selection = createCanvasSelectionController();
		selection.start = { row: 7, col: 1 };
		selection.end = { row: 7, col: 4 };
		selection.localSnapshot = "selected";
		selection.selecting = true;

		expect(shouldValidateSelectionSnapshot(selection, true, () => 0)).toBe(false);
		selection.selecting = false;
		expect(shouldValidateSelectionSnapshot(selection, true, () => 0)).toBe(true);
		expect(shouldValidateSelectionSnapshot(selection, false, () => 0)).toBe(false);
	});

	// Bug: the copy stored the Rust text (soft wraps unwrapped, so it differs from the
	// row-joined local text) and the next full-replace frame compared against it, clearing
	// the highlight right after copy-on-select.
	it("keeps the highlight when the clipboard text differs from the local row text", () => {
		const selection = createCanvasSelectionController();
		selection.start = { row: 7, col: 0 };
		selection.end = { row: 8, col: 3 };
		selection.localSnapshot = "line one\nwrap";
		selection.cachedText = "line onewrap";

		expect(shouldValidateSelectionSnapshot(selection, true, () => 0)).toBe(true);
		expect(selection.cachedText).not.toBe(selection.localSnapshot);
		selection.invalidateSnapshot();
		expect(selection.localSnapshot).toBe("");
	});

	it("extracts forward and reverse multi-row selections and trims trailing space", () => {
		const rows = new Map([
			[3, row("alpha  ")],
			[4, row("bravo  ")],
			[5, row("charlie")],
		]);
		const selection = createCanvasSelectionController();
		selection.start = { row: 3, col: 2 };
		selection.end = { row: 5, col: 3 };
		expect(selection.getLocalText((index) => rows.get(index) ?? null)).toBe("pha\nbravo\nchar");

		selection.start = { row: 5, col: 3 };
		selection.end = { row: 3, col: 2 };
		expect(selection.getLocalText((index) => rows.get(index) ?? null)).toBe("pha\nbravo\nchar");
	});

	it("copies every codepoint attached to a selected cell", () => {
		const selected = row("cafe");
		selected.cellExtras = new Map([[3, "\u0301\uFE0F"]]);
		const selection = createCanvasSelectionController();
		selection.start = { row: 0, col: 0 };
		selection.end = { row: 0, col: 3 };
		expect(selection.getLocalText(() => selected)).toBe("cafe\u0301\uFE0F");
	});

	it("tracks ranges, offscreen rows, cached text, and complete reset", () => {
		const selection = createCanvasSelectionController();
		selection.selecting = true;
		selection.start = { row: 7, col: 1 };
		selection.end = { row: 8, col: 1 };
		selection.cachedText = "selected";
		expect(selection.hasRange()).toBe(true);
		expect(selection.spansOffscreen((absoluteRow) => (absoluteRow === 7 ? 0 : null))).toBe(true);

		selection.clear();
		expect(selection.selecting).toBe(false);
		expect(selection.start).toBeNull();
		expect(selection.end).toBeNull();
		expect(selection.cachedText).toBe("");
	});
});

describe("canvas terminal search controller", () => {
	const matches = [
		{ row: 2, col_start: 0, col_end: 2 },
		{ row: 12, col_start: 1, col_end: 3 },
		{ row: 15, col_start: 2, col_end: 4 },
	];

	it("starts at the last visible match and wraps navigation", () => {
		const search = createCanvasSearchController();
		expect(search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 })).toEqual(matches[2]);
		expect(search.activeIndex).toBe(2);
		expect(search.next()).toEqual(matches[0]);
		expect(search.previous()).toEqual(matches[2]);
	});

	it("uses the first match when none is visible and clears atomically", () => {
		const search = createCanvasSearchController();
		expect(search.replace(matches, { historySize: 100, displayOffset: 0, screenRows: 10 })).toEqual(matches[0]);
		search.clear();
		expect(search.matches).toEqual([]);
		expect(search.activeIndex).toBe(-1);
		expect(search.next()).toBeNull();
	});

	// A TUI (ink agents, vim) rewrites its live rows in place. Matches anchored to
	// those absolute rows describe text that no longer exists, and painting them
	// puts a highlight over cells that never matched the query.
	describe("dropRows", () => {
		it("drops matches on rewritten rows and keeps the rest", () => {
			const search = createCanvasSearchController();
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			expect(search.dropRows(new Set([12]))).toBe(true);
			expect(search.matches).toEqual([matches[0], matches[2]]);
		});

		it("keeps the cursor on the active match when it survives", () => {
			const search = createCanvasSearchController();
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			expect(search.activeIndex).toBe(2); // matches[2]
			search.dropRows(new Set([2]));
			expect(search.activeIndex).toBe(1);
			expect(search.matches[search.activeIndex]).toEqual(matches[2]);
		});

		it("falls back to the first match when the active one is rewritten", () => {
			const search = createCanvasSearchController();
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			search.dropRows(new Set([15]));
			expect(search.activeIndex).toBe(0);
			expect(search.matches).toEqual([matches[0], matches[1]]);
		});

		it("resets to no active match when every match is rewritten", () => {
			const search = createCanvasSearchController();
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			expect(search.dropRows(new Set([2, 12, 15]))).toBe(true);
			expect(search.matches).toEqual([]);
			expect(search.activeIndex).toBe(-1);
			expect(search.next()).toBeNull();
		});

		it("reports no change when the rewritten rows carry no match", () => {
			const search = createCanvasSearchController();
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			expect(search.dropRows(new Set([3, 4, 99]))).toBe(false);
			expect(search.matches).toEqual(matches);
			expect(search.activeIndex).toBe(2);
		});

		it("is a no-op with no matches or no rewritten rows", () => {
			const search = createCanvasSearchController();
			expect(search.dropRows(new Set([1]))).toBe(false);
			search.replace(matches, { historySize: 20, displayOffset: 10, screenRows: 8 });
			expect(search.dropRows(new Set())).toBe(false);
			expect(search.matches).toEqual(matches);
		});
	});
});

describe("selection staleness", () => {
	const rows = new Map([
		[10, row("new text")],
		[11, row("more")],
	]);
	const onscreen = (index: number) => (rows.has(index) ? index - 10 : null);
	const getRow = (index: number) => rows.get(index) ?? null;

	it("never drops a selection mid-drag, even against an older copy's text", () => {
		const selection = createCanvasSelectionController();
		selection.cachedText = "previous copy";
		selection.start = { row: 10, col: 0 };
		selection.end = { row: 11, col: 3 };
		selection.selecting = true;
		expect(selection.isStale(onscreen, getRow)).toBe(false);
	});

	it("drops a finished selection once the text under it changes", () => {
		const selection = createCanvasSelectionController();
		selection.cachedText = "old text\nmore";
		selection.start = { row: 10, col: 0 };
		selection.end = { row: 11, col: 3 };
		expect(selection.isStale(onscreen, getRow)).toBe(true);
		selection.cachedText = "new text\nmore";
		expect(selection.isStale(onscreen, getRow)).toBe(false);
	});

	it("keeps a selection that reaches off-screen or was never copied", () => {
		const selection = createCanvasSelectionController();
		selection.start = { row: 9, col: 0 };
		selection.end = { row: 11, col: 3 };
		expect(selection.isStale(onscreen, getRow)).toBe(false);
		selection.cachedText = "something else";
		expect(selection.isStale(onscreen, getRow)).toBe(false);
	});
});

describe("edge auto-scroll", () => {
	it("measures rows past the edge: positive above, negative below, zero inside", () => {
		expect(edgeScrollDistance(150, 100, 500, 20)).toBe(0);
		expect(edgeScrollDistance(99, 100, 500, 20)).toBe(1);
		expect(edgeScrollDistance(55, 100, 500, 20)).toBe(3);
		expect(edgeScrollDistance(-200, 100, 500, 20)).toBe(15);
		expect(edgeScrollDistance(501, 100, 500, 20)).toBe(-1);
		expect(edgeScrollDistance(545, 100, 500, 20)).toBe(-3);
	});

	it("scrolls into history above the top and toward the bottom below it", () => {
		expect(edgeScrollLines(1, 0, 1000)).toBe(1);
		expect(edgeScrollLines(-1, 50, 1000)).toBe(-1);
		expect(edgeScrollLines(0, 50, 1000)).toBe(0);
	});

	it("speeds up the further past the edge the pointer is, up to a cap", () => {
		expect(edgeScrollLines(2, 0, 1000)).toBe(1);
		expect(edgeScrollLines(6, 0, 1000)).toBe(3);
		expect(edgeScrollLines(100, 0, 1000)).toBe(10);
		expect(edgeScrollLines(-100, 500, 1000)).toBe(-10);
	});

	it("stops at either end of the scrollback", () => {
		expect(edgeScrollLines(20, 1000, 1000)).toBe(0);
		expect(edgeScrollLines(20, 997, 1000)).toBe(3);
		expect(edgeScrollLines(-20, 0, 1000)).toBe(0);
		expect(edgeScrollLines(-20, 2, 1000)).toBe(-2);
		// Alternate screen: no history to scroll through.
		expect(edgeScrollLines(5, 0, 0)).toBe(0);
	});

	it("ends the selection at the start of the top row going up", () => {
		expect(edgeSelectionPoint(3, 400, 40, 119)).toEqual({ row: 400, col: 0 });
	});

	it("ends the selection at the end of the bottom row going down", () => {
		expect(edgeSelectionPoint(-3, 400, 40, 119)).toEqual({ row: 439, col: 119 });
		expect(edgeSelectionPoint(-1, 0, 0, -1)).toEqual({ row: 0, col: 0 });
	});
});
