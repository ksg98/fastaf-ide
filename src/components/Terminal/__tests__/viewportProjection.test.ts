import { describe, expect, it, vi } from "vitest";
import { paintCursor, paintSearchHighlights, paintSelection } from "../canvasTerminalPaint";
import {
	createCanvasSearchController,
	createCanvasSelectionController,
	selectionRowToViewport,
	viewportRowToSelectionRow,
} from "../canvasTerminalSelection";
import { type CellMetrics, type DecodedRow, decodeBinaryFrame, rowText } from "../canvasTerminalUtils";
import { createGridRenderer } from "../gridRenderer";
import { hiddenMarkerRows, planSuggestOverlay } from "../suggestOverlay";
import { ViewportProjection } from "../viewportProjection";
import capture from "./fixtures/codex-markers-1873.json";

const metrics: CellMetrics = {
	cellWidth: 10,
	cellHeight: 20,
	baseline: 15,
	fontSize: 14,
	dpr: 1,
	scaledCellWidth: 10,
	scaledCellHeight: 20,
};
function recorded() {
	const rows = new Map<number, DecodedRow>();
	let frame: ReturnType<typeof decodeBinaryFrame> = null;
	for (const data of capture.frames) {
		frame = decodeBinaryFrame(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer, rows);
		if (!frame) throw new Error("Invalid recorded frame");
		for (const row of frame.rows) rows.set(row.index, row);
	}
	if (!frame) throw new Error("No recorded frames");
	const plan = planSuggestOverlay(frame.screenRows, (i) => {
		const row = rows.get(i);
		return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
	});
	const projection = new ViewportProjection(rows, hiddenMarkerRows(plan.blocks), plan.answerMarkers);
	const answer = [...plan.answerMarkers].findLast((i) => rowText(rows.get(i)!).includes("The terminal answer"));
	if (answer === undefined) throw new Error("Recorded answer marker missing");
	return { rows, frame, plan, projection, answer };
}

describe("viewport projection", () => {
	it("round-trips retained backend cells including scrollback rows and link spans", () => {
		// Catches: selection/link hit testing using compressed positions as PTY positions.
		const { rows, projection, plan } = recorded();
		for (const [row, data] of rows)
			for (let col = 0; col < data.count; col++) {
				const point = projection.toDisplay(row, col);
				if (!point) continue;
				expect(projection.toBackend(point.row, point.col)).toEqual({ row, col });
			}
		for (const row of hiddenMarkerRows(plan.blocks)) expect(projection.displayRow(row)).toBeNull();
		const shifted = new ViewportProjection(rows, new Set([-2, -1, 1, 2]));
		for (const row of [-4, -3, 0, 3, 4]) {
			const visible = shifted.displayRow(row)!;
			expect(shifted.backendRow(visible)).toBe(row);
		}
	});
	it("maps pointer and inclusive selection boundaries across the omitted wide marker", () => {
		// Catches: marker spacer or protocol trailing space leaving three blank columns.
		const { rows, projection, answer, plan } = recorded();
		// The recorded prompt quotes suggest rows 16/17; prompt ownership keeps them visible.
		expect([...hiddenMarkerRows(plan.blocks)]).toEqual([22, 23]);
		expect(projection.toDisplay(answer, 2)).toBeNull();
		expect(projection.toDisplay(answer, 3)).toBeNull();
		expect(projection.toDisplay(answer, 4)).toBeNull();
		const point = projection.toDisplay(answer, 5)!;
		expect(point).toEqual({ row: answer, col: 2 });
		expect(projection.toBackend(point.row, 2)).toEqual({ row: answer, col: 5 });
		expect(projection.displayCol(answer, 2)).toBe(2);
		expect(projection.displayCol(answer, 5)).toBe(2);
		expect(projection.displayCol(answer, 6)).toBe(3);
		const source = rows.get(answer)!;
		const projected = projection.projectRow(source)!;
		expect(rowText(projected)).toMatch(/^ {2}The terminal/);
		expect(rowText(source)).toContain("💬");
	});
	it("paints cursor, selection and search on the same projected cell while preserving copy coordinates", () => {
		// Catches: overlays staying on raw rows or columns after text has moved.
		const { rows, frame, projection, answer } = recorded();
		const fillRect = vi.fn();
		const fillText = vi.fn();
		const ctx = { canvas: { width: 1400, height: 900 }, fillRect, fillText } as unknown as CanvasRenderingContext2D;
		const selection = createCanvasSelectionController();
		const vp = { historyBase: 900, historySize: 100, displayOffset: 30, screenRows: 35 };
		const absolute = viewportRowToSelectionRow(vp, answer);
		selection.start = { row: absolute, col: 5 };
		selection.end = { row: absolute, col: 7 };
		paintSelection(
			selection,
			(row) => selectionRowToViewport(vp, row),
			null,
			new Map(),
			rows,
			ctx,
			metrics,
			projection,
		);
		expect(fillRect).toHaveBeenCalledWith(20, answer * 20, 30, 20);
		expect(selection.start).toEqual({ row: absolute, col: 5 });
		expect(selection.getLocalText((abs) => rows.get(abs - absolute + answer) ?? null)).toBe("The");
		const search = createCanvasSearchController();
		search.replace([{ row: absolute, col_start: 5, col_end: 8 }]);
		paintSearchHighlights(search, (row) => selectionRowToViewport(vp, row), ctx, metrics, projection);
		expect(fillRect).toHaveBeenCalledWith(20, answer * 20, 30, 20);
		const input = document.createElement("input");
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		paintCursor(
			() => true,
			true,
			ctx,
			"white",
			rows,
			renderer,
			"black",
			input,
			{ ...frame, displayOffset: 0, cursorVisible: true, cursorRow: answer, cursorCol: 5, cursorShape: "beam" },
			metrics,
			projection,
		);
		expect(input.style.left).toBe("26px");
		expect(input.style.top).toBe(`${answer * 20}px`);
		fillRect.mockClear();
		const hidden = [...projection.hidden][0];
		paintCursor(
			() => true,
			true,
			ctx,
			"white",
			rows,
			renderer,
			"black",
			input,
			{ ...frame, displayOffset: 0, cursorVisible: true, cursorRow: hidden, cursorCol: 0 },
			metrics,
			projection,
		);
		expect(fillRect).not.toHaveBeenCalled();
	});
});
