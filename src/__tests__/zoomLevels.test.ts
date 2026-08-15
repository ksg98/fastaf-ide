import { describe, expect, it } from "vitest";
import { nextZoomStep, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from "../zoomLevels";

describe("nextZoomStep", () => {
	it("moves one step up and down from the default", () => {
		expect(nextZoomStep(ZOOM_DEFAULT, 1)).toBe(1.1);
		expect(nextZoomStep(ZOOM_DEFAULT, -1)).toBe(0.9);
	});

	it("walks the whole ladder without skipping or repeating", () => {
		let level: number = ZOOM_MIN;
		const up = [level];
		for (let i = 0; i < ZOOM_STEPS.length + 3; i++) {
			level = nextZoomStep(level, 1);
			if (up[up.length - 1] !== level) up.push(level);
		}
		expect(up).toEqual([...ZOOM_STEPS]);
	});

	it("clamps at both ends instead of running off the ladder", () => {
		expect(nextZoomStep(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
		expect(nextZoomStep(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
	});

	it("always moves off a value that sits between two steps", () => {
		// A level restored from an older config (or a settings slider, which steps
		// by 5%) need not be on the ladder. Snapping to the nearest step could
		// otherwise return the same side and appear to do nothing.
		for (const between of [0.95, 1.05, 1.2, 1.35, 1.6]) {
			expect(nextZoomStep(between, 1), `up from ${between}`).toBeGreaterThan(between);
			expect(nextZoomStep(between, -1), `down from ${between}`).toBeLessThan(between);
		}
	});

	it("keeps every step within the declared bounds", () => {
		for (const step of ZOOM_STEPS) {
			expect(step).toBeGreaterThanOrEqual(ZOOM_MIN);
			expect(step).toBeLessThanOrEqual(ZOOM_MAX);
		}
		expect(ZOOM_STEPS).toContain(ZOOM_DEFAULT);
	});
});
