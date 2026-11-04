import { describe, expect, it } from "vitest";

import {
	type DecodedFrame,
	type DecodedRow,
	decideFrameGrid,
	type FrameGridPrev,
	installFrameRows,
} from "../canvasTerminalUtils";

function makeRow(index: number, count = 8): DecodedRow {
	return {
		index,
		count,
		wrapped: false,
		codepoints: new Uint32Array(count),
		fg: new Uint32Array(count),
		bg: new Uint32Array(count),
		attrs: new Uint8Array(count),
	};
}

function makeFrame(opts: {
	screenRows: number;
	screenCols?: number;
	displayOffset?: number;
	historySize?: number;
	historyBase?: number;
	altScreen?: boolean;
	hasPartialRows?: boolean;
	rows: DecodedRow[];
}): DecodedFrame {
	return {
		cursorRow: 0,
		cursorCol: 0,
		cursorVisible: true,
		cursorShape: "block",
		displayOffset: opts.displayOffset ?? 0,
		historySize: opts.historySize ?? 0,
		historyBase: opts.historyBase ?? 0,
		hasSelection: false,
		keyboardFlags: 0,
		altScreen: opts.altScreen ?? false,
		bell: false,
		mouseMode: 0,
		sgrMouse: false,
		focusReporting: false,
		bracketedPaste: false,
		screenRows: opts.screenRows,
		screenCols: opts.screenCols ?? 80,
		rows: opts.rows,
		hasPartialRows: opts.hasPartialRows,
		needsFullFrame: false,
	};
}

describe("decideFrameGrid", () => {
	const prev: FrameGridPrev = {
		lastScreenRows: 24,
		lastScreenCols: 80,
		lastDisplayOffset: 0,
		lastHistorySize: 100,
		lastHistoryBase: 0,
		lastAltScreen: false,
		awaitingFullFrame: false,
	};

	it("flags geomChanged when screen rows or cols differ", () => {
		expect(decideFrameGrid(prev, makeFrame({ screenRows: 30, rows: [] }), 24).geomChanged).toBe(true);
		expect(decideFrameGrid(prev, makeFrame({ screenRows: 24, screenCols: 100, rows: [] }), 24).geomChanged).toBe(true);
		expect(decideFrameGrid(prev, makeFrame({ screenRows: 24, screenCols: 80, rows: [] }), 24).geomChanged).toBe(false);
	});

	it("flags scrollChanged when displayOffset or historySize differ", () => {
		expect(
			decideFrameGrid(prev, makeFrame({ screenRows: 24, displayOffset: 5, historySize: 100, rows: [] }), 24)
				.scrollChanged,
		).toBe(true);
		expect(
			decideFrameGrid(prev, makeFrame({ screenRows: 24, displayOffset: 0, historySize: 200, rows: [] }), 24)
				.scrollChanged,
		).toBe(true);
		expect(
			decideFrameGrid(prev, makeFrame({ screenRows: 24, displayOffset: 0, historySize: 100, rows: [] }), 24)
				.scrollChanged,
		).toBe(false);
	});

	it("waits for a full frame when scrollback eviction advances historyBase", () => {
		const decision = decideFrameGrid(
			prev,
			makeFrame({ screenRows: 24, historySize: 100, historyBase: 1, rows: [makeRow(23)] }),
			24,
		);
		expect(decision.scrollChanged).toBe(true);
		expect(decision.scrollWait).toBe(true);
	});

	it("keeps the row-map origin when history growth also parks the display offset", () => {
		const decision = decideFrameGrid(
			prev,
			makeFrame({ screenRows: 24, historySize: 101, displayOffset: 1, rows: [makeRow(23)] }),
			24,
		);
		expect(decision.scrollChanged).toBe(false);
		expect(decision.scrollWait).toBe(false);
	});

	it("does not treat a screenful of partial spans as an authoritative replacement", () => {
		const rows = Array.from({ length: 24 }, (_, i) => makeRow(i));
		const decision = decideFrameGrid(
			prev,
			makeFrame({ screenRows: 24, historyBase: 1, rows, hasPartialRows: true }),
			24,
		);
		expect(decision.fullReplace).toBe(false);
		expect(decision.scrollWait).toBe(true);
	});

	it("holds the coherent frame across repeated deltas until a whole-row replacement arrives", () => {
		const coherentRow = makeRow(0);
		coherentRow.codepoints[0] = "A".codePointAt(0)!;
		const rowMap = new Map([[0, coherentRow]]);
		const changedPartial = makeFrame({
			screenRows: 24,
			historyBase: 1,
			rows: [makeRow(23)],
			hasPartialRows: true,
		});
		const first = decideFrameGrid(prev, changedPartial, 24);
		expect(first.holdPreviousFrame).toBe(true);
		expect(first.requestFullFrame).toBe(true);
		expect(installFrameRows(rowMap, changedPartial, first)).toBe(false);
		expect(rowMap.get(0)).toBe(coherentRow);

		const waiting = { ...prev, awaitingFullFrame: true };
		const second = decideFrameGrid(waiting, changedPartial, 24);
		expect(second.holdPreviousFrame).toBe(true);
		expect(second.requestFullFrame).toBe(false);

		const replacement = decideFrameGrid(
			waiting,
			makeFrame({
				screenRows: 24,
				historyBase: 1,
				rows: Array.from({ length: 24 }, (_, i) => makeRow(i)),
			}),
			24,
		);
		expect(replacement.fullReplace).toBe(true);
		expect(replacement.holdPreviousFrame).toBe(false);
		expect(
			installFrameRows(
				rowMap,
				makeFrame({
					screenRows: 24,
					historyBase: 1,
					rows: Array.from({ length: 24 }, (_, i) => makeRow(i)),
				}),
				replacement,
			),
		).toBe(true);
		expect(rowMap.get(0)).not.toBe(coherentRow);
	});

	it("waits for whole rows after a geometry change instead of installing a partial new grid", () => {
		const partialResize = makeFrame({
			screenRows: 30,
			screenCols: 100,
			rows: [makeRow(0, 100)],
			hasPartialRows: true,
		});
		const decision = decideFrameGrid(prev, partialResize, 24);

		expect(decision.geomChanged).toBe(true);
		expect(decision.fullReplace).toBe(false);
		expect(decision.holdPreviousFrame).toBe(true);
		expect(decision.requestFullFrame).toBe(true);
	});

	it("flags fullReplace when the frame carries >= screenRows rows", () => {
		const rows = Array.from({ length: 24 }, (_, i) => makeRow(i));
		expect(decideFrameGrid(prev, makeFrame({ screenRows: 24, historySize: 100, rows }), 24).fullReplace).toBe(true);
		expect(
			decideFrameGrid(prev, makeFrame({ screenRows: 24, historySize: 100, rows: [makeRow(0)] }), 24).fullReplace,
		).toBe(false);
	});

	it("uses fallbackRows for the full-replace threshold when frame.screenRows is 0", () => {
		const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
		// frame.screenRows 0 → threshold = fallbackRows (3) → 3 rows is a full replace.
		// geomChanged because 0 !== prev.lastScreenRows (24).
		const d = decideFrameGrid(prev, makeFrame({ screenRows: 0, historySize: 100, rows }), 3);
		expect(d.fullReplace).toBe(true);
	});

	it("flags scrollWait only for a partial frame after a pure scroll (no geom change)", () => {
		const partialScroll = decideFrameGrid(
			prev,
			makeFrame({ screenRows: 24, displayOffset: 5, historySize: 100, rows: [makeRow(0)] }),
			24,
		);
		expect(partialScroll.scrollWait).toBe(true);

		// A geometry change is not a scrollWait even if scroll also changed.
		const geomAndScroll = decideFrameGrid(
			prev,
			makeFrame({ screenRows: 30, displayOffset: 5, historySize: 100, rows: [makeRow(0)] }),
			24,
		);
		expect(geomAndScroll.scrollWait).toBe(false);
		expect(geomAndScroll.holdPreviousFrame).toBe(true);

		// A full frame after a scroll is a fullReplace, not a scrollWait.
		const fullScroll = decideFrameGrid(
			prev,
			makeFrame({
				screenRows: 24,
				displayOffset: 5,
				historySize: 100,
				rows: Array.from({ length: 24 }, (_, i) => makeRow(i)),
			}),
			24,
		);
		expect(fullScroll.scrollWait).toBe(false);
		expect(fullScroll.fullReplace).toBe(true);
	});

	it("detects primary/alternate screen changes even when all numeric coordinates match", () => {
		const primaryPrev = { ...prev, lastAltScreen: false } as FrameGridPrev;
		const enterAlt = decideFrameGrid(
			primaryPrev,
			makeFrame({ screenRows: 24, historySize: 100, altScreen: true, rows: [makeRow(0)] }),
			24,
		);

		expect(enterAlt.screenChanged).toBe(true);
		expect(enterAlt.scrollWait).toBe(true);

		const altPrev = { ...prev, lastAltScreen: true } as FrameGridPrev;
		const exitAlt = decideFrameGrid(
			altPrev,
			makeFrame({ screenRows: 24, historySize: 100, altScreen: false, rows: [makeRow(0)] }),
			24,
		);

		expect(exitAlt.screenChanged).toBe(true);
		expect(exitAlt.scrollWait).toBe(true);
	});

	it("does not report a screen change while consecutive alternate frames stay in the same era", () => {
		const altPrev = { ...prev, lastAltScreen: true } as FrameGridPrev;
		const nextAlt = decideFrameGrid(
			altPrev,
			makeFrame({ screenRows: 24, historySize: 100, altScreen: true, rows: [makeRow(0)] }),
			24,
		);

		expect(nextAlt.screenChanged).toBe(false);
	});
});
