import { describe, expect, it } from "vitest";
import { createCanvasScrollController, ROW_CACHE_CHUNK, ROW_CACHE_MAX } from "../canvasTerminalScroll";

describe("canvas terminal scroll controller", () => {
	it("tracks fractional gestures and clamps their pending backend offset", () => {
		const scroll = createCanvasScrollController();
		expect(scroll.applyDelta(-2.5, 0, 10)).toBe(2.5);
		expect(scroll.pendingOffset).toBe(2);
		expect(scroll.applyDelta(-20, 0, 10)).toBe(10);
		expect(scroll.pendingOffset).toBe(10);
		expect(scroll.scrolling).toBe(true);
	});

	it("snaps and hands off only when the matching backend frame arrives", () => {
		const scroll = createCanvasScrollController();
		scroll.applyDelta(-3.6, 0, 20);
		expect(scroll.snap()).toBe(4);
		expect(scroll.acceptSettledFrame(3)).toBe(false);
		expect(scroll.position).toBe(4);
		expect(scroll.acceptSettledFrame(4)).toBe(true);
		expect(scroll.position).toBeNull();
		expect(scroll.settleTarget).toBeNull();
	});

	it("owns cache state and cancels every transient field", () => {
		const scroll = createCanvasScrollController();
		scroll.requestedChunks.add(2);
		scroll.position = 1.5;
		scroll.pendingOffset = 1;
		scroll.scrolling = true;
		scroll.settleTarget = 2;
		scroll.gestureDistancePx = 42;
		scroll.clearCache();
		expect(scroll.requestedChunks.size).toBe(0);

		scroll.cancel();
		expect(scroll.position).toBeNull();
		expect(scroll.pendingOffset).toBeNull();
		expect(scroll.scrolling).toBe(false);
		expect(scroll.settleTarget).toBeNull();
		expect(scroll.gestureDistancePx).toBe(0);
	});

	it("invalidates delayed cache responses when the screen generation changes", () => {
		const scroll = createCanvasScrollController();
		const requestGeneration = scroll.cacheGeneration;
		expect(requestGeneration).toBeTypeOf("number");

		scroll.rowCache.set(7, {} as never);
		scroll.requestedChunks.add(0);
		scroll.clearCache();

		expect(scroll.cacheGeneration).toBe(requestGeneration + 1);
		expect(scroll.isCacheGenerationCurrent(requestGeneration)).toBe(false);
		expect(scroll.rowCache.size).toBe(0);
		expect(scroll.requestedChunks.size).toBe(0);
	});

	// The cache is keyed by an eviction-stable ALL-TIME row index, so a line that
	// scrolls in always gets a fresh key and never overwrites an old entry. Every
	// writer therefore has to be bounded, not just the scroll-gesture one: a tab
	// that is never resized, wheel-scrolled or alt-screened grows the map for the
	// life of the session, ~2.6 KB per row.
	describe("cacheRows", () => {
		const row = (n: number) => ({ index: n }) as never;

		it("bounds the cache however many rows are written", () => {
			const scroll = createCanvasScrollController();
			for (let abs = 0; abs < ROW_CACHE_MAX + 500; abs++) {
				scroll.cacheRows([{ abs, row: row(abs) }]);
			}
			expect(scroll.rowCache.size).toBe(ROW_CACHE_MAX);
		});

		it("evicts the oldest rows and keeps the newest", () => {
			const scroll = createCanvasScrollController();
			const total = ROW_CACHE_MAX + 3;
			for (let abs = 0; abs < total; abs++) {
				scroll.cacheRows([{ abs, row: row(abs) }]);
			}
			// The rows just written are the ones a scroll gesture is about to paint.
			expect(scroll.rowCache.has(total - 1)).toBe(true);
			expect(scroll.rowCache.has(total - ROW_CACHE_MAX)).toBe(true);
			expect(scroll.rowCache.has(0)).toBe(false);
			expect(scroll.rowCache.has(2)).toBe(false);
		});

		it("bounds a single oversized write too", () => {
			const scroll = createCanvasScrollController();
			const batch = Array.from({ length: ROW_CACHE_MAX + 64 }, (_, abs) => ({ abs, row: row(abs) }));
			scroll.cacheRows(batch);
			expect(scroll.rowCache.size).toBe(ROW_CACHE_MAX);
		});

		// `requestedChunks` is a "do not ask again" set: ensureCacheBand skips every
		// chunk in it and a successful fetch never removes its id. So a chunk whose
		// rows get evicted has to leave that set too, or scrolling back to it paints
		// blanks forever — the whole-cache clear this replaced dropped both together.
		it("lets an evicted chunk be requested again", () => {
			const scroll = createCanvasScrollController();
			const chunkOf = (abs: number) => Math.floor(abs / ROW_CACHE_CHUNK);
			const total = ROW_CACHE_MAX + 3 * ROW_CACHE_CHUNK;
			for (let abs = 0; abs < total; abs++) {
				scroll.requestedChunks.add(chunkOf(abs));
				scroll.cacheRows([{ abs, row: row(abs) }]);
			}

			expect(scroll.rowCache.has(0)).toBe(false);
			expect(scroll.requestedChunks.has(chunkOf(0))).toBe(false);
			// A chunk still fully cached stays claimed — re-fetching it would be a
			// pointless round trip.
			expect(scroll.requestedChunks.has(chunkOf(total - 1))).toBe(true);
		});

		it("keeps a partially evicted chunk requestable", () => {
			// Half a chunk in cache is not a paintable chunk: the band fetch has to
			// be free to ask for it again.
			const scroll = createCanvasScrollController();
			const total = ROW_CACHE_MAX + 1;
			for (let abs = 0; abs < total; abs++) {
				scroll.requestedChunks.add(Math.floor(abs / ROW_CACHE_CHUNK));
				scroll.cacheRows([{ abs, row: row(abs) }]);
			}
			// Row 0 was evicted; rows 1..63 of chunk 0 are still cached.
			expect(scroll.rowCache.has(1)).toBe(true);
			expect(scroll.requestedChunks.has(0)).toBe(false);
		});

		it("does not invalidate in-flight chunk requests when it evicts", () => {
			// Eviction is not invalidation: dropping the oldest rows says nothing
			// about the rows a pending fetchChunk is on its way to deliver. Bumping
			// the generation here would make every fill during steady output throw
			// away a chunk that is still correct.
			const scroll = createCanvasScrollController();
			const generation = scroll.cacheGeneration;
			for (let abs = 0; abs < ROW_CACHE_MAX + 10; abs++) {
				scroll.cacheRows([{ abs, row: row(abs) }]);
			}
			expect(scroll.cacheGeneration).toBe(generation);
			expect(scroll.isCacheGenerationCurrent(generation)).toBe(true);
		});
	});
});
