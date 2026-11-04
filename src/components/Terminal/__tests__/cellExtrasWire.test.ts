import { describe, expect, it } from "vitest";
import { type DecodedRow, decodeBinaryFrame, decodeStyledRange, rowText } from "../canvasTerminalUtils";

const HEADER_SIZE = 26;
const CELL_SIZE = 11;
const ROW_PARTIAL_FLAG = 0x4000;

interface WireRow {
	index: number;
	text: string;
	startCol?: number;
}

interface Extra {
	ordinal: number;
	col: number;
	scalars: number[];
}

function writeCells(view: DataView, offset: number, text: string): number {
	for (const character of text) {
		view.setUint32(offset, character.codePointAt(0) ?? 0, true);
		offset += CELL_SIZE;
	}
	return offset;
}

function trailerBytes(entries?: Extra[]): number {
	return entries ? 8 + entries.reduce((size, entry) => size + 5 + entry.scalars.length * 4, 0) : 0;
}

function writeTrailer(view: DataView, offset: number, entries?: Extra[]): number {
	if (!entries) return offset;
	for (const byte of [0x54, 0x43, 0x58, 0x31]) view.setUint8(offset++, byte); // TCX1
	view.setUint32(offset, entries.length, true);
	offset += 4;
	for (const entry of entries) {
		view.setUint16(offset, entry.ordinal, true);
		offset += 2;
		view.setUint16(offset, entry.col, true);
		offset += 2;
		view.setUint8(offset++, entry.scalars.length);
		for (const scalar of entry.scalars) {
			view.setUint32(offset, scalar, true);
			offset += 4;
		}
	}
	return offset;
}

function buildFrame(rows: WireRow[], cols: number, entries?: Extra[]): ArrayBuffer {
	const coreBytes = rows.reduce(
		(size, row) => size + 4 + (row.startCol === undefined ? 0 : 2) + [...row.text].length * CELL_SIZE,
		0,
	);
	const buffer = new ArrayBuffer(HEADER_SIZE + coreBytes + trailerBytes(entries));
	const view = new DataView(buffer);
	view.setUint16(0, rows.length, true);
	view.setUint8(6, 1);
	view.setUint16(18, rows.length, true);
	view.setUint16(20, cols, true);

	let offset = HEADER_SIZE;
	for (const row of rows) {
		view.setUint16(offset, row.index, true);
		offset += 2;
		const count = [...row.text].length;
		view.setUint16(offset, count | (row.startCol === undefined ? 0 : ROW_PARTIAL_FLAG), true);
		offset += 2;
		if (row.startCol !== undefined) {
			view.setUint16(offset, row.startCol, true);
			offset += 2;
		}
		offset = writeCells(view, offset, row.text);
	}
	writeTrailer(view, offset, entries);
	return buffer;
}

function buildStyled(rows: WireRow[], cols: number, entries?: Extra[]): ArrayBuffer {
	const coreBytes = rows.reduce((size, row) => size + 6 + [...row.text].length * CELL_SIZE, 0);
	const buffer = new ArrayBuffer(12 + coreBytes + trailerBytes(entries));
	const view = new DataView(buffer);
	view.setUint16(8, cols, true);
	view.setUint16(10, rows.length, true);
	let offset = 12;
	for (const row of rows) {
		view.setUint32(offset, row.index, true);
		offset += 4;
		view.setUint16(offset, [...row.text].length, true);
		offset += 2;
		offset = writeCells(view, offset, row.text);
	}
	writeTrailer(view, offset, entries);
	return buffer;
}

function baseRow(text: string, extras: ReadonlyMap<number, string>): DecodedRow {
	const codepoints = Uint32Array.from([...text].map((character) => character.codePointAt(0) ?? 0));
	return {
		index: 0,
		count: codepoints.length,
		wrapped: false,
		codepoints,
		cellExtras: extras,
		fg: new Uint32Array(codepoints.length),
		bg: new Uint32Array(codepoints.length),
		attrs: new Uint8Array(codepoints.length),
	};
}

describe("TCX1 cell extras trailer", () => {
	it("keeps the legacy no-trailer frame valid", () => {
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "plain" }], 5));
		expect(rowText(frame!.rows[0])).toBe("plain");
		expect(frame?.needsFullFrame).toBe(false);
	});

	it("uses wire row ordinals and preserves exact scalar order", () => {
		const frame = decodeBinaryFrame(
			buildFrame(
				[
					{ index: 8, text: "alpha" },
					{ index: 2, text: "beta " },
				],
				5,
				[{ ordinal: 1, col: 1, scalars: [0x301, 0xfe0f] }],
			),
		);

		expect(rowText(frame!.rows[0])).toBe("alpha");
		expect(rowText(frame!.rows[1])).toBe("be\u0301\uFE0Fta ");
		expect(frame?.rows[1].cellExtras?.get(1)).toBe("\u0301\uFE0F");
	});

	it("clears overwritten extras in a partial span and retains untouched cells", () => {
		const base = new Map([
			[
				0,
				baseRow(
					"abcdef",
					new Map([
						[1, "\u0301"],
						[5, "\u0327"],
					]),
				),
			],
		]);
		const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "XY", startCol: 1 }], 6), base);

		expect(rowText(frame!.rows[0])).toBe("aXYde\u0066\u0327");
		expect(frame?.rows[0].cellExtras?.has(1)).toBe(false);
		expect(frame?.rows[0].cellExtras?.get(5)).toBe("\u0327");
		expect(base.get(0)?.cellExtras?.get(1)).toBe("\u0301");
	});

	it("decodes the same trailer for styled scrollback rows", () => {
		const range = decodeStyledRange(
			buildStyled([{ index: 40, text: "cafe" }], 4, [{ ordinal: 0, col: 3, scalars: [0x301] }]),
		);
		expect(rowText(range!.rows[0].row)).toBe("cafe\u0301");
	});

	it.each([
		["empty trailer", []],
		["zero scalar count", [{ ordinal: 0, col: 0, scalars: [] }]],
		["unknown ordinal", [{ ordinal: 1, col: 0, scalars: [0x301] }]],
		["column outside the transmitted row", [{ ordinal: 0, col: 4, scalars: [0x301] }]],
		["surrogate scalar", [{ ordinal: 0, col: 0, scalars: [0xd800] }]],
		[
			"duplicate cell",
			[
				{ ordinal: 0, col: 0, scalars: [0x301] },
				{ ordinal: 0, col: 0, scalars: [0x302] },
			],
		],
	] satisfies Array<[string, Extra[]]>)(
		"rejects malformed live trailers and requests a full frame: %s",
		(_name, entries) => {
			const frame = decodeBinaryFrame(buildFrame([{ index: 0, text: "test" }], 4, entries));
			expect(frame?.rows).toEqual([]);
			expect(frame?.needsFullFrame).toBe(true);
		},
	);

	it("rejects trailing bytes after a trailer", () => {
		const valid = buildFrame([{ index: 0, text: "test" }], 4, [{ ordinal: 0, col: 0, scalars: [0x301] }]);
		const bytes = new Uint8Array(valid.byteLength + 1);
		bytes.set(new Uint8Array(valid));
		const frame = decodeBinaryFrame(bytes.buffer);
		expect(frame?.rows).toEqual([]);
		expect(frame?.needsFullFrame).toBe(true);
	});

	it("rejects truncated declared core records without installing partial rows", () => {
		const valid = buildFrame([{ index: 0, text: "test" }], 4);
		const frame = decodeBinaryFrame(valid.slice(0, valid.byteLength - 1));
		expect(frame?.rows).toEqual([]);
		expect(frame?.needsFullFrame).toBe(true);
	});

	it("invalidates the whole styled range for malformed trailers or core records", () => {
		const malformed = buildStyled([{ index: 40, text: "test" }], 4, [{ ordinal: 0, col: 0, scalars: [0x110000] }]);
		const core = buildStyled([{ index: 40, text: "test" }], 4);
		expect(decodeStyledRange(malformed)).toBeNull();
		expect(decodeStyledRange(core.slice(0, core.byteLength - 1))).toBeNull();
	});
});
