import { describe, expect, it } from "vitest";
import { applyTrackResize, computeGrid } from "../../utils/multiviewGrid";

describe("computeGrid", () => {
	it("clamps zero/negative counts to a 1x1 grid", () => {
		expect(computeGrid(0)).toEqual({ cols: 1, rows: 1, spans: [1] });
		expect(computeGrid(-3)).toEqual({ cols: 1, rows: 1, spans: [1] });
	});

	it("uses the fixed table for small counts", () => {
		expect(computeGrid(1)).toEqual({ cols: 1, rows: 1, spans: [1] });
		expect(computeGrid(2)).toEqual({ cols: 2, rows: 1, spans: [1, 1] });
		expect(computeGrid(3)).toEqual({ cols: 2, rows: 2, spans: [1, 1, 2] });
		expect(computeGrid(4)).toEqual({ cols: 2, rows: 2, spans: [1, 1, 1, 1] });
		expect(computeGrid(5)).toEqual({ cols: 6, rows: 2, spans: [2, 2, 2, 3, 3] });
		expect(computeGrid(6)).toEqual({ cols: 3, rows: 2, spans: [1, 1, 1, 1, 1, 1] });
	});

	describe("applyTrackResize", () => {
		it("moves weight between the two tracks at the boundary, preserving the total", () => {
			const next = applyTrackResize([1, 1], 0, 0.25);
			expect(next[0]).toBeCloseTo(1.5);
			expect(next[1]).toBeCloseTo(0.5);
			expect(next[0] + next[1]).toBeCloseTo(2);
		});

		it("only touches the adjacent pair", () => {
			const next = applyTrackResize([1, 1, 1], 1, 0.1);
			expect(next[0]).toBe(1);
			expect(next[1]).toBeCloseTo(1.3);
			expect(next[2]).toBeCloseTo(0.7);
		});

		it("clamps so each track keeps the minimum fraction", () => {
			const next = applyTrackResize([1, 1], 0, 5);
			expect(next[1]).toBeCloseTo(0.2); // 10% of total 2
			expect(next[0]).toBeCloseTo(1.8);
			const back = applyTrackResize([1, 1], 0, -5);
			expect(back[0]).toBeCloseTo(0.2);
		});

		it("returns the input unchanged for out-of-range boundaries", () => {
			expect(applyTrackResize([1, 1], -1, 0.5)).toEqual([1, 1]);
			expect(applyTrackResize([1, 1], 1, 0.5)).toEqual([1, 1]);
		});
	});

	it("produces a hole-free near-square grid for larger counts", () => {
		for (let n = 7; n <= 24; n++) {
			const spec = computeGrid(n);
			expect(spec.spans).toHaveLength(n);
			expect(spec.cols).toBe(Math.ceil(Math.sqrt(n)));
			expect(spec.rows).toBe(Math.ceil(n / spec.cols));
			// Spans fill the grid exactly — no holes, no overflow
			const total = spec.spans.reduce((a, b) => a + b, 0);
			expect(total).toBe(spec.cols * spec.rows);
			for (const span of spec.spans) {
				expect(span).toBeGreaterThanOrEqual(1);
				expect(span).toBeLessThanOrEqual(spec.cols);
			}
		}
	});
});
