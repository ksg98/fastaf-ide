import { expect, it } from "vitest";
import { createCanvasSelectionController } from "../canvasTerminalSelection";
import { getLocalSelectionText, readProjectedSelectionText } from "../canvasTerminalText";
import { decodeStyledRange, rowText } from "../canvasTerminalUtils";
import { hiddenMarkerRows, planSuggestOverlay } from "../suggestOverlay";
import { ViewportProjection } from "../viewportProjection";
import capture from "./fixtures/claude-suggest-1935.json";

const range = decodeStyledRange(Uint8Array.from(atob(capture.base64), (c) => c.charCodeAt(0)).buffer)!;
const rows = new Map(range.rows.map(({ abs, row }) => [abs, row]));
const read = async (start: { row: number; col: number }, end: { row: number; col: number }) => {
	const lines = [];
	for (let i = start.row; i <= end.row; i++) {
		lines.push(
			rowText(rows.get(i)!)
				.slice(i === start.row ? start.col : 0, i === end.row ? end.col + 1 : undefined)
				.trimEnd(),
		);
	}
	return lines.join("\n");
};
// Catches: reversed selection bypassing interior omitted rows or dropping the footer.
it("copies reversed recorded selection without its omitted row", async () => {
	const text = await readProjectedSelectionText({ row: 5382, col: 200 }, { row: 5379, col: 0 }, rows, read);
	expect(text).not.toContain("suggest:");
	expect(text).toContain("Baked for 7m 43s");
});
// Catches: an all-hidden range falling back to raw backend text.
it("copies no text for a selection confined to the omitted marker", async () => {
	expect(await readProjectedSelectionText({ row: 5380, col: 0 }, { row: 5380, col: 209 }, rows, read)).toBe("");
});
// Catches: projection rewriting ordinary copied text or selection endpoints.
it("preserves ordinary captured text and selected columns", async () => {
	expect(await readProjectedSelectionText({ row: 5382, col: 2 }, { row: 5382, col: 6 }, rows, read)).toBe("Baked");
});

// Catches: the local fallback reintroducing a marker or a selectable blank row.
it("uses the same omitted rows in the local selection fallback", () => {
	const selection = createCanvasSelectionController();
	selection.start = { row: 5379, col: 0 };
	selection.end = { row: 5382, col: 200 };
	const local = new Map(
		range.rows.map(({ abs, row }) => [abs - capture.start, { ...row, index: abs - capture.start }]),
	);
	const text = getLocalSelectionText(selection, (abs) => abs - capture.start, local);
	expect(text).toBe("\n✻ Baked for 7m 43s · done 10:15 AM");
});

// Catches: removing only the protocol row leaves its two surrounding separators adjacent.
it("keeps one ordinary separator between the recorded answer and completion footer", () => {
	const plan = planSuggestOverlay(
		5435,
		(i) => {
			const row = rows.get(i);
			return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
		},
		capture.start,
	);
	const projection = new ViewportProjection(rows, hiddenMarkerRows(plan.blocks));
	expect(projection.displayRow(5380)).toBeNull();
	expect(projection.displayRow(5381)).toBeNull();
	expect(projection.displayRow(5382)).toBe(5380);
});

// Catches: separator cleanup deleting content when only one adjacent row is blank.
it("preserves the sole separator and adjacent ordinary content", () => {
	const get = (i: number) => {
		const row = rows.get(i);
		return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
	};
	const noLeading = planSuggestOverlay(5383, (i) => (i === 5379 ? get(5378) : get(i)), 5379);
	expect(hiddenMarkerRows(noLeading.blocks).has(5381)).toBe(false);
	const noTrailing = planSuggestOverlay(5382, (i) => (i === 5381 ? get(5382) : get(i)), 5379);
	expect(hiddenMarkerRows(noTrailing.blocks).has(5381)).toBe(false);
});
