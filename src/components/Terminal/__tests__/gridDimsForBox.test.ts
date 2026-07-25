import { describe, expect, it } from "vitest";

import { GUTTER_PX, gridDimsForBox, SCROLLBAR_PX } from "../canvasTerminalUtils";

describe("gridDimsForBox", () => {
	it("subtracts gutter + scrollbar from the width before dividing into columns", () => {
		// 820px box, 8px cells: usable width = 820 - 6 - 14 = 800 → 100 cols.
		const d = gridDimsForBox(820, 480, 8, 16);
		expect(d.cols).toBe((820 - GUTTER_PX - SCROLLBAR_PX) / 8);
		expect(d.cols).toBe(100);
		expect(d.rows).toBe(30);
	});

	it("floors fractional cells (never overcounts)", () => {
		// usable width 795 / 8 = 99.375 → 99; height 479 / 16 = 29.9 → 29.
		const d = gridDimsForBox(815, 479, 8, 16);
		expect(d.cols).toBe(99);
		expect(d.rows).toBe(29);
	});

	it("matches the CanvasTerminal remeasure formula exactly (single source of truth)", () => {
		// Regression for the reconnect double-SIGWINCH: Terminal.tsx's old
		// calcGridSize divided the RAW width (no gutter/scrollbar), yielding ~2
		// extra columns vs CanvasTerminal → resize ping-pong on every reconnect.
		const width = 1000;
		const cellWidth = 9.6;
		const canvasFormula = Math.floor((width - GUTTER_PX - SCROLLBAR_PX) / cellWidth);
		const oldTerminalFormula = Math.floor(width / cellWidth);
		expect(gridDimsForBox(width, 500, cellWidth, 18).cols).toBe(canvasFormula);
		expect(canvasFormula).not.toBe(oldTerminalFormula); // the bug this kills
	});

	it("returns non-positive dims for degenerate boxes (caller bails)", () => {
		expect(gridDimsForBox(0, 0, 8, 16).cols).toBeLessThanOrEqual(0);
		expect(gridDimsForBox(0, 0, 8, 16).rows).toBeLessThanOrEqual(0);
	});
});
