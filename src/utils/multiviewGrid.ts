/** Grid layout for the multiview mode (all live terminals tiled at once).
 *  Deterministic count → (cols, rows, spans) table for small counts, with a
 *  near-square fallback. Spans are per tile in DOM order and always sum to
 *  cols*rows so the grid has no holes (the last tile absorbs the remainder). */
/** Tile cap: past 3×3 tiles are unreadably small (agent TUIs want ~40+ cols)
 *  and WebGL renderer contexts are browser-capped at roughly 8-16 per page. */
export const MAX_MULTIVIEW_TILES = 9;

export interface MultiviewGridSpec {
	cols: number;
	rows: number;
	/** Column span per tile, in DOM order. */
	spans: number[];
}

export function computeGrid(count: number): MultiviewGridSpec {
	const n = Math.max(1, count);
	switch (n) {
		case 1:
			return { cols: 1, rows: 1, spans: [1] };
		case 2:
			return { cols: 2, rows: 1, spans: [1, 1] };
		case 3:
			// 2 on top, 1 full-width below
			return { cols: 2, rows: 2, spans: [1, 1, 2] };
		case 4:
			return { cols: 2, rows: 2, spans: [1, 1, 1, 1] };
		case 5:
			// 3 on top, 2 below (6 tracks so both rows fill exactly)
			return { cols: 6, rows: 2, spans: [2, 2, 2, 3, 3] };
		case 6:
			return { cols: 3, rows: 2, spans: [1, 1, 1, 1, 1, 1] };
		default: {
			const cols = Math.ceil(Math.sqrt(n));
			const rows = Math.ceil(n / cols);
			const spans = new Array<number>(n).fill(1);
			spans[n - 1] += cols * rows - n;
			return { cols, rows, spans };
		}
	}
}

/** Move the boundary between track `index` and `index + 1` by `deltaFraction`
 *  of the container (positive = grow the left/top track). Total weight is
 *  preserved; each track keeps at least `minFraction` of the container.
 *  Returns a new array; the input is not mutated. */
export function applyTrackResize(
	weights: readonly number[],
	index: number,
	deltaFraction: number,
	minFraction = 0.1,
): number[] {
	if (index < 0 || index >= weights.length - 1) return [...weights];
	const total = weights.reduce((a, b) => a + b, 0);
	const min = total * minFraction;
	const delta = deltaFraction * total;
	const pair = weights[index] + weights[index + 1];
	const next = [...weights];
	next[index] = Math.min(Math.max(weights[index] + delta, min), pair - min);
	next[index + 1] = pair - next[index];
	return next;
}
