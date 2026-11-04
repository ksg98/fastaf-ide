import { settingsStore } from "../../stores/settings";
import type { CanvasSearchController, CanvasSelectionController } from "./canvasTerminalSelection";
import {
	type CellMetrics,
	type CursorShape,
	cellText,
	computeCursorRect,
	type DecodedFrame,
	type DecodedRow,
	GUTTER_PX,
} from "./canvasTerminalUtils";
import type { GridRenderer } from "./gridRenderer";
import { scrollbarThumb } from "./scrollbarThumb";
import type { ViewportProjection } from "./viewportProjection";

/** Theme colours for the search wash and the active-match bar. Canvas `fillStyle`
 *  cannot read `var(...)`, so the caller resolves the theme tokens; the defaults are
 *  the fixed colours used before the overlay followed the theme. */
export interface SearchHighlightColors {
	fill: string;
	active: string;
}

const DEFAULT_SEARCH_COLORS: SearchHighlightColors = { fill: "rgba(255, 180, 50, 0.2)", active: "#e8984c" };

export function paintSearchHighlights(
	search: CanvasSearchController,
	absRowToViewport: (absRow: number) => number | null,
	octx: CanvasRenderingContext2D,
	m: CellMetrics,
	projection?: ViewportProjection,
	colors: SearchHighlightColors = DEFAULT_SEARCH_COLORS,
) {
	if (search.matches.length === 0) return;
	for (let i = 0; i < search.matches.length; i++) {
		const match = search.matches[i];
		const backendRow = absRowToViewport(match.row);
		const vpRow = backendRow === null ? null : projection ? projection.displayRow(backendRow) : backendRow;
		if (vpRow === null || backendRow === null) continue;
		const isActive = i === search.activeIndex;
		const colStart = projection?.displayCol(backendRow, match.col_start) ?? match.col_start;
		const colEnd = projection?.displayCol(backendRow, match.col_end) ?? match.col_end;
		const x = colStart * m.cellWidth;
		const y = vpRow * m.cellHeight;
		const w = (colEnd - colStart) * m.cellWidth;
		octx.fillStyle = colors.fill;
		octx.fillRect(x, y, w, m.cellHeight);
		if (isActive) {
			octx.fillStyle = colors.active;
			octx.fillRect(x, y + m.cellHeight - 2, w, 2);
		}
	}
}

export interface SelectionPaintOptions {
	/** Selection wash; the caller resolves it from the theme accent. */
	fill?: string;
	/** Visible window in selection rows. Rows outside it are skipped without a
	 *  lookup: select-all spans the whole scrollback, and walking every history row
	 *  on each repaint (only to have the viewport mapping reject it) would cost far
	 *  more than the paint itself on a long buffer. */
	firstRow?: number;
	lastRow?: number;
}

export function paintSelection(
	selection: CanvasSelectionController,
	selectionAbsRowToViewport: (absRow: number) => number | null,
	overlayScrollOffset: number | null,
	rowCache: Map<number, DecodedRow>,
	rowMap: Map<number, DecodedRow>,
	octx: CanvasRenderingContext2D,
	m: CellMetrics,
	projection?: ViewportProjection,
	options: SelectionPaintOptions = {},
) {
	if (!selection.start || !selection.end) return;
	const absStartRow = Math.min(selection.start.row, selection.end.row);
	const absEndRow = Math.max(selection.start.row, selection.end.row);

	octx.fillStyle = options.fill ?? "rgba(58, 130, 220, 0.35)";

	const firstVisible = Math.max(absStartRow, options.firstRow ?? absStartRow);
	const lastVisible = Math.min(absEndRow, options.lastRow ?? absEndRow);
	for (let absRi = firstVisible; absRi <= lastVisible; absRi++) {
		const vpRow = selectionAbsRowToViewport(absRi);
		if (vpRow === null) continue;
		// During a gesture both the selection and row cache use the same
		// eviction-stable all-time row index. At rest rowMap is viewport-relative.
		const row = overlayScrollOffset != null ? rowCache.get(absRi) : rowMap.get(vpRow);
		if (!row) continue;
		const displayRow = projection ? projection.displayRow(vpRow) : vpRow;
		if (displayRow === null) continue;
		const y = displayRow * m.cellHeight;
		const column = (col: number) => projection?.displayCol(vpRow, col) ?? col;

		if (absStartRow === absEndRow) {
			const c0 = Math.min(selection.start.col, selection.end.col);
			const c1 = Math.max(selection.start.col, selection.end.col);
			octx.fillRect(column(c0) * m.cellWidth, y, (column(c1 + 1) - column(c0)) * m.cellWidth, m.cellHeight);
		} else if (absRi === absStartRow) {
			const isStartFirst = selection.start.row <= selection.end.row;
			const startCol = isStartFirst ? selection.start.col : selection.end.col;
			octx.fillRect(
				column(startCol) * m.cellWidth,
				y,
				(column(row.count) - column(startCol)) * m.cellWidth,
				m.cellHeight,
			);
		} else if (absRi === absEndRow) {
			const isStartFirst = selection.start.row <= selection.end.row;
			const endCol = isStartFirst ? selection.end.col : selection.start.col;
			octx.fillRect(0, y, column(endCol + 1) * m.cellWidth, m.cellHeight);
		} else {
			octx.fillRect(0, y, column(row.count) * m.cellWidth, m.cellHeight);
		}
	}
}

export function paintCursor(
	focused: () => boolean,
	cursorBlinkOn: boolean,
	octx: CanvasRenderingContext2D,
	cachedFgDefault: string,
	rowMap: Map<number, DecodedRow>,
	gridRenderer: GridRenderer,
	cachedBgDefault: string,
	keyInputRef: HTMLInputElement,
	frame: DecodedFrame,
	m: CellMetrics,
	projection?: ViewportProjection,
) {
	if (frame.displayOffset > 0) return;
	if (!frame.cursorVisible) return;
	if (!focused()) return;
	if (!cursorBlinkOn) return;

	const settingShape: CursorShape =
		settingsStore.state.cursorStyle === "block"
			? "block"
			: settingsStore.state.cursorStyle === "underline"
				? "underline"
				: "beam";
	const shape: CursorShape = frame.cursorShape !== "block" ? frame.cursorShape : settingShape;
	const point = projection
		? projection.toDisplay(frame.cursorRow, frame.cursorCol)
		: { row: frame.cursorRow, col: frame.cursorCol };
	if (!point) return;
	const rect = computeCursorRect(shape, point.row, point.col, m);

	octx.fillStyle = cachedFgDefault;
	octx.fillRect(rect.x, rect.y, rect.w, rect.h);

	if (shape === "block") {
		const row = rowMap.get(frame.cursorRow);
		const col = frame.cursorCol;
		if (row && col < row.count) {
			const cp = row.codepoints[col];
			const glyph = cellText(row, col);
			if (glyph !== "" && (cp !== 0x20 || row.cellExtras?.has(col))) {
				const fontFamily = settingsStore.getFontFamily();
				octx.font = gridRenderer.buildFontStyle(row.attrs[col], m.fontSize, fontFamily);
				octx.fillStyle = cachedBgDefault;
				octx.fillText(glyph, rect.x, point.row * m.cellHeight + m.baseline);
			}
		}
	}

	syncImePosition(keyInputRef, point.row, point.col, m);
}

export function syncImePosition(keyInputRef: HTMLInputElement, row: number, col: number, m: CellMetrics) {
	const x = GUTTER_PX + col * m.cellWidth;
	const y = row * m.cellHeight;
	keyInputRef.style.left = `${x}px`;
	keyInputRef.style.top = `${y}px`;
	keyInputRef.style.height = `${m.cellHeight}px`;
	keyInputRef.style.fontSize = `${m.fontSize}px`;
}

export function thumbFor(scrollbarTrackHeight: number, lastResizeRows: number, frame: DecodedFrame) {
	return scrollbarThumb({
		// Track height comes from the resize-time cache, not scrollbarRef.clientHeight;
		// visible rows = the authoritative resize row count — no per-frame
		// canvasRef.clientHeight read (layout-forcing).
		trackH: scrollbarTrackHeight,
		visibleRows: lastResizeRows || 24,
		historySize: frame.historySize,
		displayOffset: frame.displayOffset,
	});
}
