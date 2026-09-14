import type { DecodedRow } from "./canvasTerminalUtils";

/**
 * How many decoded rows the smooth-scroll cache may hold. At roughly 2.6 KB per
 * row (three `Uint32Array(cols)` plus a `Uint8Array(cols)`) this is ~15 MB of
 * scrollback available to paint locally, which covers a fast flick over several
 * screens without a round trip.
 */
export const ROW_CACHE_MAX = 6000;

/**
 * Rows per prefetch chunk. Lives here because the cache and the "already asked
 * for it" set are keyed by it: eviction has to release the chunk ids it drops
 * rows from, or the band fetch never asks for them again.
 */
export const ROW_CACHE_CHUNK = 64;

export interface CanvasScrollController {
	readonly rowCache: Map<number, DecodedRow>;
	readonly requestedChunks: Set<number>;
	readonly cacheGeneration: number;
	position: number | null;
	pendingOffset: number | null;
	inFlight: boolean;
	scrolling: boolean;
	settleTarget: number | null;
	gestureDistancePx: number;
	clearCache: () => void;
	/**
	 * Write decoded rows into the cache, evicting the oldest ones past
	 * `ROW_CACHE_MAX`. The ONLY way to fill it: the key is an eviction-stable
	 * all-time row index, so a line scrolling in always takes a fresh slot and
	 * nothing is ever overwritten — an unbounded writer grows for the session's
	 * whole life.
	 */
	cacheRows: (rows: Iterable<{ abs: number; row: DecodedRow }>) => void;
	isCacheGenerationCurrent: (generation: number) => boolean;
	applyDelta: (deltaLines: number, currentOffset: number, historySize: number) => number;
	snap: () => number | null;
	acceptSettledFrame: (displayOffset: number) => boolean;
	cancel: () => void;
}

export function createCanvasScrollController(): CanvasScrollController {
	const rowCache = new Map<number, DecodedRow>();
	const requestedChunks = new Set<number>();
	let position: number | null = null;
	let pendingOffset: number | null = null;
	let inFlight = false;
	let scrolling = false;
	let settleTarget: number | null = null;
	let gestureDistancePx = 0;
	let cacheGeneration = 0;

	return {
		rowCache,
		requestedChunks,
		get cacheGeneration() {
			return cacheGeneration;
		},
		get position() {
			return position;
		},
		set position(value) {
			position = value;
		},
		get pendingOffset() {
			return pendingOffset;
		},
		set pendingOffset(value) {
			pendingOffset = value;
		},
		get inFlight() {
			return inFlight;
		},
		set inFlight(value) {
			inFlight = value;
		},
		get scrolling() {
			return scrolling;
		},
		set scrolling(value) {
			scrolling = value;
		},
		get settleTarget() {
			return settleTarget;
		},
		set settleTarget(value) {
			settleTarget = value;
		},
		get gestureDistancePx() {
			return gestureDistancePx;
		},
		set gestureDistancePx(value) {
			gestureDistancePx = value;
		},
		clearCache() {
			cacheGeneration++;
			rowCache.clear();
			requestedChunks.clear();
		},
		cacheRows(rows) {
			for (const { abs, row } of rows) rowCache.set(abs, row);
			// Insertion order is Map order, so the oldest keys come first. Evicting
			// them — rather than clearing the whole cache — keeps the rows a gesture
			// is about to paint, and needs no generation bump: a dropped old row says
			// nothing about a chunk still in flight, and invalidating one during
			// steady output would discard a fetch that is still correct.
			if (rowCache.size <= ROW_CACHE_MAX) return;
			const excess = rowCache.size - ROW_CACHE_MAX;
			let dropped = 0;
			for (const key of rowCache.keys()) {
				rowCache.delete(key);
				// `requestedChunks` means "already asked for, never ask again": a
				// successful fetch leaves its id there forever. So an evicted row has
				// to release its chunk, or scrolling back to it paints blanks with no
				// way to refill them. A chunk that lost even one row is not paintable,
				// hence release on the first row dropped, not the last.
				requestedChunks.delete(Math.floor(key / ROW_CACHE_CHUNK));
				if (++dropped === excess) break;
			}
		},
		isCacheGenerationCurrent(generation) {
			return generation === cacheGeneration;
		},
		applyDelta(deltaLines, currentOffset, historySize) {
			scrolling = true;
			const base = position ?? currentOffset;
			position = Math.max(0, Math.min(historySize, base - deltaLines));
			pendingOffset = Math.floor(position);
			return position;
		},
		snap() {
			scrolling = false;
			gestureDistancePx = 0;
			if (position === null) return null;
			const target = Math.round(position);
			position = target;
			pendingOffset = target;
			settleTarget = target;
			return target;
		},
		acceptSettledFrame(displayOffset) {
			if (settleTarget === null || displayOffset !== settleTarget) return false;
			settleTarget = null;
			position = null;
			return true;
		},
		cancel() {
			position = null;
			pendingOffset = null;
			scrolling = false;
			settleTarget = null;
			gestureDistancePx = 0;
		},
	};
}
