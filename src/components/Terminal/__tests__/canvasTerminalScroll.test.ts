import { describe, expect, it } from "vitest";
import { createCanvasScrollController } from "../canvasTerminalScroll";

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
});
