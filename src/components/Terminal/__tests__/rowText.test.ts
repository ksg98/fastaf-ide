import { describe, expect, it } from "vitest";
import type { DecodedRow } from "../canvasTerminalUtils";
import { rowText } from "../canvasTerminalUtils";

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
