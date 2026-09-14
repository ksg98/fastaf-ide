import { describe, expect, it } from "vitest";
import { decodeBinaryFrame, decodeStyledRange } from "../canvasTerminalUtils";

/**
 * Wire contract for the wrapped-row bit (#8fc7).
 *
 * The grid is the only place that knows a logical line spilled onto the next
 * display row, and it says so in bit 15 of the row's `col_count`
 * (`ROW_WRAPPED_FLAG` in src-tauri/src/terminal_grid.rs). Before that bit
 * existed the decoders reported `isWrapped: false` for every row, which made the
 * suggest overlay's continuation scan dead code and left a wrapped
 * `suggest: [ … ]` block painted raw on screen.
 *
 * These build the bytes by hand on purpose: it is the only test on either side
 * that fails if one half of the format moves without the other.
 */

const CELL_SIZE = 11;
const HEADER_SIZE = 26;
const ROW_WRAPPED_FLAG = 0x8000;

function writeCells(view: DataView, offset: number, text: string): number {
	for (const char of text) {
		view.setUint32(offset, char.codePointAt(0) ?? 0, true);
		offset += 4;
		// fg rgb, bg rgb, attrs — irrelevant here, left at zero.
		offset += 7;
	}
	return offset;
}

/** One frame, `rows` of `text.length` columns each, wrapped flag per row. */
function buildFrame(rows: Array<{ text: string; wrapped: boolean }>, cols: number): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + rows.length * (4 + cols * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, rows.length, true); // num_rows
	view.setUint16(2, 0, true); // cursor_row
	view.setUint16(4, 0, true); // cursor_col
	view.setUint8(6, 1); // cursor_visible
	view.setUint32(7, 0, true); // display_offset
	view.setUint32(11, 0, true); // history_size
	view.setUint8(15, 0); // has_selection
	view.setUint8(16, 0); // keyboard_flags
	view.setUint8(17, 0); // frame_flags
	view.setUint16(18, rows.length, true); // num_lines
	view.setUint16(20, cols, true); // num_cols
	view.setUint32(22, 0, true); // history_base

	let offset = HEADER_SIZE;
	rows.forEach((row, index) => {
		view.setUint16(offset, index, true);
		offset += 2;
		view.setUint16(offset, cols | (row.wrapped ? ROW_WRAPPED_FLAG : 0), true);
		offset += 2;
		offset = writeCells(view, offset, row.text.padEnd(cols, " "));
	});
	return buffer;
}

function buildStyledRange(rows: Array<{ text: string; wrapped: boolean }>, cols: number): ArrayBuffer {
	const buffer = new ArrayBuffer(12 + rows.length * (6 + cols * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint32(0, 0, true); // start_abs
	view.setUint32(4, 0, true); // history_size
	view.setUint16(8, cols, true); // num_cols
	view.setUint16(10, rows.length, true); // row_count

	let offset = 12;
	rows.forEach((row, index) => {
		view.setUint32(offset, index, true);
		offset += 4;
		view.setUint16(offset, cols | (row.wrapped ? ROW_WRAPPED_FLAG : 0), true);
		offset += 2;
		offset = writeCells(view, offset, row.text.padEnd(cols, " "));
	});
	return buffer;
}

describe("wrapped-row flag on the wire", () => {
	// The captured repro: 69 chars of suggest in a 48-column terminal.
	const wrappedSuggest = [
		{ text: "suggest: [ Committa il fix | Aggiungi il debounc", wrapped: true },
		{ text: "e | Riavvio e provo ]", wrapped: false },
	];

	it("decodeBinaryFrame reports which rows continue onto the next", () => {
		const frame = decodeBinaryFrame(buildFrame(wrappedSuggest, 48));
		expect(frame?.rows.map((row) => row.wrapped)).toEqual([true, false]);
	});

	it("keeps the column count intact under the flag", () => {
		const frame = decodeBinaryFrame(buildFrame(wrappedSuggest, 48));
		// A count read without masking would come back as 32816 and blow up every
		// per-cell loop that trusts it.
		expect(frame?.rows.map((row) => row.count)).toEqual([48, 48]);
		expect(frame?.rows[0]?.codepoints.length).toBe(48);
	});

	it("decodeStyledRange carries the same flag for the scroll cache", () => {
		// The scroll path repaints from this cache, so a mask that only worked on
		// live frames would drop off the moment the user scrolled.
		const range = decodeStyledRange(buildStyledRange(wrappedSuggest, 48));
		expect(range?.rows.map((entry) => entry.row.wrapped)).toEqual([true, false]);
		expect(range?.rows.map((entry) => entry.row.count)).toEqual([48, 48]);
	});

	it("reports no wrapping for ordinary rows", () => {
		const frame = decodeBinaryFrame(buildFrame([{ text: "plain line", wrapped: false }], 48));
		expect(frame?.rows[0]?.wrapped).toBe(false);
	});
});
