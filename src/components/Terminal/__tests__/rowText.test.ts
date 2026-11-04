import { describe, expect, it } from "vitest";
import type { DecodedRow } from "../canvasTerminalUtils";
import { cellToTextOffset, rowText, rowTextLayout, textSpanToCellRanges } from "../canvasTerminalUtils";

/**
 * A row whose codepoint reads are counted, so a test can tell a recomputation
 * from a cache hit without reaching into the cache itself.
 */
function countingRow(text: string): { row: DecodedRow; reads: () => number } {
	const points = Uint32Array.from([...text].map((c) => c.codePointAt(0) ?? 32));
	let reads = 0;
	const codepoints = new Proxy(points, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
			return Reflect.get(target, prop, receiver);
		},
	});
	const row = {
		index: 0,
		count: points.length,
		wrapped: false,
		codepoints,
		fg: new Uint32Array(points.length),
		bg: new Uint32Array(points.length),
		attrs: new Uint8Array(points.length),
	} as unknown as DecodedRow;
	return { row, reads: () => reads };
}

describe("rowText", () => {
	it("renders codepoints, mapping the empty cell to a space", () => {
		const { row } = countingRow("hi");
		row.codepoints[1] = 0;
		expect(rowText(row)).toBe("h ");
	});

	it("renders astral codepoints as one character", () => {
		const { row } = countingRow("a😀b");
		expect(rowText(row)).toBe("a😀b");
	});

	it("caches UTF-16 cell boundaries including decomposed and astral content", () => {
		const { row } = countingRow("🦇ab");
		row.cellExtras = new Map([[1, "\u0301"]]);
		const layout = rowTextLayout(row);
		expect(layout.text).toBe("🦇a\u0301b");
		expect([...layout.utf16Starts]).toEqual([0, 2, 4, 5]);
	});

	it("aligns backend UTF-16 offsets past a wide spacer and combining mark", () => {
		// The wire encodes the wide spacer as zero; backend row text omits it.
		const codepoints = [..."🦇 cafe https://x"].map((character) => character.codePointAt(0)!);
		codepoints.splice(1, 0, 0);
		const wireRow: DecodedRow = {
			index: 4,
			count: codepoints.length,
			wrapped: false,
			codepoints: Uint32Array.from(codepoints),
			cellExtras: new Map([[6, "\u0301"]]),
			fg: new Uint32Array(codepoints.length),
			bg: new Uint32Array(codepoints.length),
			attrs: new Uint8Array(codepoints.length),
		};
		const backendText = "🦇 cafe\u0301 https://x";
		const start = backendText.indexOf("https://x");
		expect(textSpanToCellRanges([{ index: 4, row: wireRow }], backendText, start, backendText.length)).toEqual([
			{ row: 4, colStart: 8, colEnd: 17 },
		]);
	});

	it("aligns wrapped backend text without counting wide spacer cells as text", () => {
		const firstPoints = Uint32Array.from([0x1f987, 0, 0x20, 0x63, 0x61, 0x66, 0x65, 0x20, 0x68, 0x74]);
		const secondPoints = Uint32Array.from([..."tps://x"].map((character) => character.codePointAt(0)!));
		const makeRow = (index: number, codepoints: Uint32Array, wrapped: boolean): DecodedRow => ({
			index,
			count: codepoints.length,
			wrapped,
			codepoints,
			cellExtras: index === 0 ? new Map([[6, "\u0301"]]) : undefined,
			fg: new Uint32Array(codepoints.length),
			bg: new Uint32Array(codepoints.length),
			attrs: new Uint8Array(codepoints.length),
		});
		const rows = [
			{ index: 0, row: makeRow(0, firstPoints, true) },
			{ index: 1, row: makeRow(1, secondPoints, false) },
		];
		const backendText = "🦇 cafe\u0301 https://x";
		const start = backendText.indexOf("https://x");
		expect(textSpanToCellRanges(rows, backendText, start, backendText.length)).toEqual([
			{ row: 0, colStart: 8, colEnd: 10 },
			{ row: 1, colStart: 0, colEnd: 7 },
		]);
		expect(cellToTextOffset(rows, backendText, 1, 0)).toBe(start + 2);
	});

	it("refuses authoritative text that cannot be reconstructed from the cells", () => {
		const { row } = countingRow("plain");
		expect(textSpanToCellRanges([{ index: 0, row }], "different", 0, 4)).toBeNull();
		expect(cellToTextOffset([{ index: 0, row }], "different", 0, 0)).toBeNull();
	});

	// The row text feeds the link scan, the suggest-overlay scan and the dirty-row
	// prefilter, so a single frame asks for the same row several times. The decoder
	// builds a fresh row object per changed row and never mutates one in place, so
	// the object's identity is a sound cache key: same object, same text, always.
	it("builds the string once per row object however many callers ask", () => {
		const { row, reads } = countingRow("suggest: [ A | B | C ]");
		const first = rowText(row);
		const after = reads();
		expect(after).toBeGreaterThan(0);

		expect(rowText(row)).toBe(first);
		expect(rowText(row)).toBe(first);
		expect(reads()).toBe(after);
	});

	it("keeps distinct rows apart", () => {
		const a = countingRow("alpha");
		const b = countingRow("beta");
		expect(rowText(a.row)).toBe("alpha");
		expect(rowText(b.row)).toBe("beta");
		expect(rowText(a.row)).toBe("alpha");
	});
});
