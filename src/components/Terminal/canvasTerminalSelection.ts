import { cellText, type DecodedRow } from "./canvasTerminalUtils";

export interface SelectionPoint {
	col: number;
	row: number;
}

export interface SelectionViewport {
	historyBase: number;
	historySize: number;
	displayOffset: number;
	screenRows: number;
}

/** Eviction-stable row id for a cell in the current viewport. */
export function viewportRowToSelectionRow(viewport: SelectionViewport, viewportRow: number): number {
	return viewport.historyBase + viewport.historySize - viewport.displayOffset + viewportRow;
}

/** Current viewport row for an eviction-stable selection row, or null when off-screen. */
export function selectionRowToViewport(viewport: SelectionViewport, selectionRow: number): number | null {
	const viewportTop = viewport.historyBase + viewport.historySize - viewport.displayOffset;
	const viewportRow = selectionRow - viewportTop;
	return viewportRow >= 0 && viewportRow < viewport.screenRows ? viewportRow : null;
}

/** Backend grid-relative row for a retained selection row. */
export function selectionRowToGridRow(viewport: SelectionViewport, selectionRow: number): number | null {
	const gridRow = selectionRow - viewport.historyBase;
	const retainedRows = viewport.historySize + viewport.screenRows;
	return gridRow >= 0 && gridRow < retainedRows ? gridRow : null;
}

export function isSelectionRowsExpiredError(error: unknown): boolean {
	return String(error).includes("selection rows are no longer retained");
}

export async function commitSelectionCopy(
	readText: () => Promise<string>,
	writeText: (text: string) => Promise<void>,
): Promise<{ kind: "copied"; text: string } | { kind: "empty" } | { kind: "expired" }> {
	let text: string;
	try {
		text = await readText();
	} catch (error) {
		if (isSelectionRowsExpiredError(error)) return { kind: "expired" };
		throw error;
	}
	if (!text) return { kind: "empty" };
	await writeText(text);
	return { kind: "copied", text };
}

export interface SearchMatch {
	row: number;
	col_start: number;
	col_end: number;
}

export interface SearchViewport {
	historySize: number;
	displayOffset: number;
	screenRows: number;
}

export interface CanvasSelectionController {
	selecting: boolean;
	start: SelectionPoint | null;
	end: SelectionPoint | null;
	cachedText: string;
	/** Viewport-local text at copy time; the clipboard text differs (soft wraps are unwrapped), so only this one is comparable with later local reads. */
	localSnapshot: string;
	invalidateSnapshot: () => void;
	clear: () => void;
	hasRange: () => boolean;
	spansOffscreen: (toViewportRow: (absoluteRow: number) => number | null) => boolean;
	getLocalText: (
		getRow: (absoluteRow: number) => DecodedRow | null,
		isHidden?: (absoluteRow: number) => boolean,
	) => string;
	/**
	 * True when a finished, copied selection no longer covers the text it copied
	 * (the app redrew those rows), so it should be dropped. Never true mid-drag:
	 * `cachedText` is still the PREVIOUS copy then, so every redraw would read as
	 * "changed" and clear the selection under the pointer — which is what killed
	 * edge auto-scroll after its first line.
	 */
	isStale: (
		toViewportRow: (absoluteRow: number) => number | null,
		getRow: (absoluteRow: number) => DecodedRow | null,
	) => boolean;
}

export interface CanvasSearchController {
	readonly matches: SearchMatch[];
	readonly activeIndex: number;
	replace: (matches: SearchMatch[], viewport?: SearchViewport) => SearchMatch | null;
	clear: () => void;
	dropRows: (rows: Set<number>) => boolean;
	next: () => SearchMatch | null;
	previous: () => SearchMatch | null;
}

/** Completed selections may be checked against replacement content; live drags may not. */
export function shouldValidateSelectionSnapshot(
	selection: CanvasSelectionController,
	fullReplace: boolean,
	toViewportRow: (absoluteRow: number) => number | null,
): boolean {
	return Boolean(
		selection.start &&
			selection.localSnapshot &&
			!selection.selecting &&
			fullReplace &&
			!selection.spansOffscreen(toViewportRow),
	);
}

export function createCanvasSelectionController(): CanvasSelectionController {
	let selecting = false;
	let start: SelectionPoint | null = null;
	let end: SelectionPoint | null = null;
	let cachedText = "";
	let localSnapshot = "";

	const controller: CanvasSelectionController = {
		get selecting() {
			return selecting;
		},
		set selecting(value) {
			selecting = value;
		},
		get start() {
			return start;
		},
		set start(value) {
			start = value;
		},
		get end() {
			return end;
		},
		set end(value) {
			end = value;
		},
		get cachedText() {
			return cachedText;
		},
		set cachedText(value) {
			cachedText = value;
		},
		get localSnapshot() {
			return localSnapshot;
		},
		set localSnapshot(value) {
			localSnapshot = value;
		},
		invalidateSnapshot() {
			cachedText = "";
			localSnapshot = "";
		},
		clear() {
			selecting = false;
			start = null;
			end = null;
			cachedText = "";
			localSnapshot = "";
		},
		hasRange() {
			return Boolean(start && end && (start.row !== end.row || start.col !== end.col));
		},
		spansOffscreen(toViewportRow) {
			if (!start || !end) return false;
			const firstRow = Math.min(start.row, end.row);
			const lastRow = Math.max(start.row, end.row);
			for (let row = firstRow; row <= lastRow; row++) {
				if (toViewportRow(row) === null) return true;
			}
			return false;
		},
		getLocalText(getRow, isHidden) {
			if (!start || !end) return "";
			const firstRow = Math.min(start.row, end.row);
			const lastRow = Math.max(start.row, end.row);
			const forward = start.row <= end.row;
			const lines: string[] = [];

			for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex++) {
				if (isHidden?.(rowIndex)) continue;
				const row = getRow(rowIndex);
				if (!row) {
					lines.push("");
					continue;
				}

				let startCol = 0;
				let endCol = row.count - 1;
				if (firstRow === lastRow) {
					startCol = Math.min(start.col, end.col);
					endCol = Math.max(start.col, end.col);
				} else if (rowIndex === firstRow) {
					startCol = forward ? start.col : end.col;
				} else if (rowIndex === lastRow) {
					endCol = forward ? end.col : start.col;
				}

				let text = "";
				for (let col = startCol; col <= endCol; col++) {
					text += cellText(row, col) || " ";
				}
				lines.push(text.replace(/\s+$/, ""));
			}

			while (lines.length > 0 && lines.at(-1)! === "") lines.pop();
			return lines.join("\n");
		},
		isStale(toViewportRow, getRow) {
			if (selecting || !start || !cachedText) return false;
			// Off-screen rows read back empty, which would look like a change.
			if (controller.spansOffscreen(toViewportRow)) return false;
			return controller.getLocalText(getRow) !== cachedText;
		},
	};
	return controller;
}

/** Auto-scroll tick while a drag-selection is held past the viewport edge. */
export const EDGE_SCROLL_TICK_MS = 40;

/**
 * How far past the viewport edge the pointer is, in rows: positive above the
 * top (scroll into history), negative below the bottom, 0 inside.
 */
export function edgeScrollDistance(clientY: number, top: number, bottom: number, cellHeight: number): number {
	if (cellHeight <= 0) return 0;
	if (clientY < top) return Math.ceil((top - clientY) / cellHeight);
	if (clientY > bottom) return -Math.ceil((clientY - bottom) / cellHeight);
	return 0;
}

/**
 * Lines to scroll on one auto-scroll tick (positive = into history), faster
 * the further past the edge the pointer is, and never past either end of the
 * scrollback — a scroll at the limit is a no-op that still repaints the grid.
 */
export function edgeScrollLines(distance: number, displayOffset: number, historySize: number): number {
	if (distance === 0) return 0;
	const step = Math.min(Math.ceil(Math.abs(distance) / 2), 10);
	if (distance > 0) return Math.min(step, Math.max(0, historySize - displayOffset));
	return displayOffset > 0 ? -Math.min(step, displayOffset) : 0;
}

/**
 * Where a drag-selection ends while auto-scrolling: the start of the top
 * visible row going up, the end of the bottom visible row going down. Absolute
 * rows, so `viewportTop` is `historySize - displayOffset`.
 */
export function edgeSelectionPoint(
	distance: number,
	viewportTop: number,
	screenRows: number,
	lastCol: number,
): SelectionPoint {
	if (distance > 0) return { col: 0, row: viewportTop };
	return { col: Math.max(0, lastCol), row: viewportTop + Math.max(1, screenRows) - 1 };
}

export function createCanvasSearchController(): CanvasSearchController {
	let matches: SearchMatch[] = [];
	let activeIndex = -1;

	const active = () => (activeIndex >= 0 ? (matches[activeIndex] ?? null) : null);

	return {
		get matches() {
			return matches;
		},
		get activeIndex() {
			return activeIndex;
		},
		replace(nextMatches, viewport) {
			matches = nextMatches;
			activeIndex = matches.length > 0 ? nearestVisibleMatch(matches, viewport) : -1;
			return active();
		},
		clear() {
			matches = [];
			activeIndex = -1;
		},
		dropRows(rows) {
			if (matches.length === 0 || rows.size === 0) return false;
			const previouslyActive = active();
			const kept = matches.filter((match) => !rows.has(match.row));
			if (kept.length === matches.length) return false;
			matches = kept;
			// Keep the cursor on the same match when it survived, so a re-render
			// mid-search doesn't teleport the user to a different hit.
			const survivingIndex = previouslyActive ? kept.indexOf(previouslyActive) : -1;
			activeIndex = survivingIndex >= 0 ? survivingIndex : kept.length > 0 ? 0 : -1;
			return true;
		},
		next() {
			if (matches.length === 0) return null;
			activeIndex = (activeIndex + 1) % matches.length;
			return active();
		},
		previous() {
			if (matches.length === 0) return null;
			activeIndex = (activeIndex - 1 + matches.length) % matches.length;
			return active();
		},
	};
}

function nearestVisibleMatch(matches: SearchMatch[], viewport?: SearchViewport): number {
	if (!viewport) return 0;
	const viewportTop = viewport.historySize - viewport.displayOffset;
	const viewportBottom = viewportTop + viewport.screenRows;
	for (let index = matches.length - 1; index >= 0; index--) {
		const row = matches[index].row;
		if (row >= viewportTop && row < viewportBottom) return index;
	}
	return 0;
}
