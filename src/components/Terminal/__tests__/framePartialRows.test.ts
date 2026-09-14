import { describe, expect, it } from "vitest";
import { type DecodedRow, decodeBinaryFrame, rowText } from "../canvasTerminalUtils";

/**
 * Wire contract for the partial-row bit (F23).
 *
 * A row whose `col_count` carries `ROW_PARTIAL_FLAG` (bit 14) ships only the
 * columns alacritty reported as damaged, preceded by a `start_col: u16`. The
 * decoder merges them into the row already on screen. Measured over 11 real
 * captures, the old whole-row format shipped 2.44 cells per damaged cell on
 * average and 11.8x on the busiest agent session.
 *
 * Bytes are built by hand here for the same reason as the wrapped-row suite: it
 * is the only test that fails if one half of the format moves without the other.
 */

const CELL_SIZE = 11;
const HEADER_SIZE = 26;
const ROW_WRAPPED_FLAG = 0x8000;
const ROW_PARTIAL_FLAG = 0x4000;

interface WireRow {
	index: number;
	text: string;
	/** Omitted = a whole row in the legacy format, no start_col on the wire. */
	startCol?: number;
	wrapped?: boolean;
}

function rowBytes(row: WireRow): number {
	return 4 + (row.startCol === undefined ? 0 : 2) + row.text.length * CELL_SIZE;
}

/** Build a dirty-row frame. `cols` is the screen width the header advertises. */
function buildFrame(rows: WireRow[], cols: number): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + rows.reduce((n, r) => n + rowBytes(r), 0));
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
	for (const row of rows) {
		view.setUint16(offset, row.index, true);
		offset += 2;
		const flags = (row.wrapped ? ROW_WRAPPED_FLAG : 0) | (row.startCol === undefined ? 0 : ROW_PARTIAL_FLAG);
		view.setUint16(offset, row.text.length | flags, true);
		offset += 2;
		if (row.startCol !== undefined) {
			view.setUint16(offset, row.startCol, true);
			offset += 2;
		}
		for (const char of row.text) {
			view.setUint32(offset, char.codePointAt(0) ?? 0, true);
			offset += 4;
			// fg rgb, bg rgb, attrs — left at zero, irrelevant to the merge.
			offset += 7;
		}
	}
	return buffer;
}

/** The screen as the canvas holds it: one full row, decoded from a legacy frame. */
function baseScreen(text: string, cols: number): Map<number, DecodedRow> {
	const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: text.padEnd(cols, " ") }], cols));
	if (!frame) throw new Error("base frame failed to decode");
	return new Map(frame.rows.map((row) => [row.index, row]));
}

describe("partial-row flag on the wire", () => {
	it("merges a damaged span into the row already on screen", () => {
		const base = baseScreen("aaaaaaaa", 8);
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "XY", startCol: 3 }], 8), base);

		expect(frame?.needsFullFrame).toBe(false);
		expect(frame?.rows).toHaveLength(1);
		expect(rowText(frame!.rows[0])).toBe("aaaXYaaa");
		expect(frame?.rows[0].count).toBe(8);
	});

	it("leaves the row it merged from untouched", () => {
		const base = baseScreen("aaaaaaaa", 8);
		const before = base.get(0)!;
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "XY", startCol: 3 }], 8), base);

		// rowTextCache keys off row identity and the scroll cache may still hold
		// this object, so the merge must build a new row rather than mutate.
		expect(frame?.rows[0]).not.toBe(before);
		expect(rowText(before)).toBe("aaaaaaaa");
	});

	it("drops a partial row it cannot place and asks for a full frame", () => {
		const frame = decodeBinaryFrame(buildFrame([{ index: 4, text: "XY", startCol: 3 }], 8), new Map());

		expect(frame?.rows).toHaveLength(0);
		expect(frame?.needsFullFrame).toBe(true);
	});

	it("keeps decoding the rows it can place after dropping one it cannot", () => {
		const base = baseScreen("aaaaaaaa", 8);
		const frame = decodeBinaryFrame(
			buildFrame(
				[
					{ index: 7, text: "ZZ", startCol: 0 },
					{ index: 0, text: "XY", startCol: 3 },
				],
				8,
			),
			base,
		);

		// The dropped row's cells must be stepped over, not decoded as the next
		// row's header — a misread here silently shifts every following row.
		expect(frame?.needsFullFrame).toBe(true);
		expect(frame?.rows.map((row) => row.index)).toEqual([0]);
		expect(rowText(frame!.rows[0])).toBe("aaaXYaaa");
	});

	it("reads the wrapped bit alongside the partial bit", () => {
		const base = baseScreen("aaaaaaaa", 8);
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "XY", startCol: 3, wrapped: true }], 8), base);

		expect(frame?.rows[0].wrapped).toBe(true);
		expect(rowText(frame!.rows[0])).toBe("aaaXYaaa");
	});

	it("clips a span that runs past the row it is merging into", () => {
		const base = baseScreen("aaaa", 4);
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "XYZZ", startCol: 2 }], 4), base);

		// A resize can land a span past the row being merged; the cells beyond the
		// width are skipped rather than written out of bounds.
		expect(rowText(frame!.rows[0])).toBe("aaXY");
		expect(frame?.rows[0].count).toBe(4);
	});

	it("decodes a whole-row frame exactly as before, with no base at all", () => {
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "hello" }], 5));

		expect(frame?.needsFullFrame).toBe(false);
		expect(rowText(frame!.rows[0])).toBe("hello");
		expect(frame?.rows[0].count).toBe(5);
	});
});
