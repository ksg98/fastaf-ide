import type { CanvasSelectionController, SelectionPoint } from "./canvasTerminalSelection";
import {
	cellToTextOffset,
	type DecodedRow,
	rowText,
	rowTextLayout,
	textSpanToCellRanges,
	utf16SpanToCellRange,
} from "./canvasTerminalUtils";

import { hiddenMarkerRows, planSuggestOverlay } from "./suggestOverlay";

/** Copy the same retained row runs that the viewport paints, including off-screen selections.
 * Backend reads still own soft-wrap normalization and eviction checks.
 */
export async function readProjectedSelectionText(
	start: SelectionPoint,
	end: SelectionPoint,
	rows: ReadonlyMap<number, DecodedRow>,
	read: (start: SelectionPoint, end: SelectionPoint) => Promise<string>,
): Promise<string> {
	const [first, last] =
		start.row < end.row || (start.row === end.row && start.col <= end.col) ? [start, end] : [end, start];
	let low = first.row;
	let high = last.row + 1;
	for (const index of rows.keys()) {
		low = Math.min(low, index);
		high = Math.max(high, index + 1);
	}
	const plan = planSuggestOverlay(
		high,
		(i) => {
			const row = rows.get(i);
			return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
		},
		low,
	);
	const hidden = hiddenMarkerRows(plan.blocks);
	const parts: string[] = [];
	let run = first.row;
	for (let row = first.row; row <= last.row + 1; row++) {
		if (row <= last.row && !hidden.has(row)) continue;
		if (run < row) {
			let text = await read(
				{ row: run, col: run === first.row ? first.col : 0 },
				row - 1 === last.row ? last : { row: row - 1, col: rows.get(row - 1)!.count - 1 },
			);
			if (row <= last.row) {
				// Backend selection reads trim trailing newlines. Restore only
				// retained blank rows at a split, not the omitted marker rows.
				let trailingBlanks = 0;
				for (let index = row - 1; index >= run; index--) {
					const retained = rows.get(index);
					if (!retained || rowText(retained).trim() !== "") break;
					trailingBlanks++;
				}
				const needed = Math.min(trailingBlanks, row - run - 1);
				const existing = text.length - text.replace(/\n+$/, "").length;
				text += "\n".repeat(Math.max(0, needed - existing));
			}
			parts.push(text);
		}
		run = row + 1;
	}
	return parts.join("\n");
}

export type HoveredLink = {
	row: number;
	colStart: number;
	colEnd: number;
	path: string;
	line?: number;
	col?: number;
	spans?: { row: number; colStart: number; colEnd: number }[];
};

/** What a span underlines on screen right now; "" when there is none. */
export function underlinedText(
	rowMap: Map<number, DecodedRow>,
	row: number,
	span: { colStart: number; colEnd: number } | undefined,
): string {
	const decoded = rowMap.get(row);
	if (!decoded || !span) return "";
	const { text, utf16Starts } = rowTextLayout(decoded);
	return text.slice(
		utf16Starts[Math.min(span.colStart, decoded.count)],
		utf16Starts[Math.min(span.colEnd, decoded.count)],
	);
}

/** The text each span of the link covers on screen now. */
export function hoverSignature(rowMap: Map<number, DecodedRow>, link: HoveredLink): string {
	return (link.spans ?? [link]).map((sp) => `${sp.row}:${underlinedText(rowMap, sp.row, sp)}`).join("\n");
}

export function underlinedTextAt(
	rowMap: Map<number, DecodedRow>,
	pressSpanAt: (row: number, col: number) => { colStart: number; colEnd: number } | undefined,
	row: number,
	col: number,
): string {
	return underlinedText(rowMap, row, pressSpanAt(row, col));
}

export function getLocalSelectionText(
	selection: CanvasSelectionController,
	selectionAbsRowToViewport: (absRow: number) => number | null,
	rowMap: Map<number, DecodedRow>,
): string {
	const lastRow = Math.max(0, ...rowMap.keys()) + 1;
	const plan = planSuggestOverlay(lastRow, (i) => {
		const row = rowMap.get(i);
		return row ? { text: rowText(row), isWrapped: rowMap.get(i - 1)?.wrapped ?? false } : null;
	});
	const hidden = hiddenMarkerRows(plan.blocks);
	return selection.getLocalText(
		(absRi) => {
			const vpRow = selectionAbsRowToViewport(absRi);
			return vpRow !== null ? (rowMap.get(vpRow) ?? null) : null;
		},
		(absRi) => {
			const vpRow = selectionAbsRowToViewport(absRi);
			return vpRow !== null && hidden.has(vpRow);
		},
	);
}

export const rowStringSpanToCells = (
	rowMap: Map<number, DecodedRow>,
	rowIndex: number,
	start: number,
	end: number,
): [number, number] | null => {
	const row = rowMap.get(rowIndex);
	return row ? utf16SpanToCellRange(row, start, end) : null;
};

export const logicalRows = (
	rowMap: Map<number, DecodedRow>,
	startRow: number,
): { index: number; row: DecodedRow }[] => {
	const rows: { index: number; row: DecodedRow }[] = [];
	for (let rowIndex = startRow; ; rowIndex++) {
		const row = rowMap.get(rowIndex);
		if (!row) return [];
		rows.push({ index: rowIndex, row });
		if (!row.wrapped) return rows;
	}
};

export const logicalStringSpanToCells = (
	rowMap: Map<number, DecodedRow>,
	startRow: number,
	text: string,
	start: number,
	end: number,
): { row: number; colStart: number; colEnd: number }[] => {
	return textSpanToCellRanges(logicalRows(rowMap, startRow), text, start, end) ?? [];
};

export const logicalCellToStringOffset = (
	rowMap: Map<number, DecodedRow>,
	startRow: number,
	text: string,
	rowIndex: number,
	col: number,
): number | null => cellToTextOffset(logicalRows(rowMap, startRow), text, rowIndex, col);
