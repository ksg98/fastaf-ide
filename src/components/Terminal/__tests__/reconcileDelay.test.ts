import { describe, expect, it } from "vitest";

import { RECONCILE_DEBOUNCE_MS, RECONCILE_MAX_WAIT_MS, reconcileDelay } from "../canvasTerminalUtils";

describe("reconcileDelay", () => {
	const start = 10_000; // burst start timestamp (ms)

	it("uses the plain trailing debounce while far from the max-wait deadline", () => {
		expect(reconcileDelay(start, start)).toBe(RECONCILE_DEBOUNCE_MS);
		expect(reconcileDelay(start + 400, start)).toBe(RECONCILE_DEBOUNCE_MS);
	});

	it("shrinks the delay so the timer fires by the max-wait deadline", () => {
		// 200ms left to the deadline → delay capped to 200, not 250.
		expect(reconcileDelay(start + RECONCILE_MAX_WAIT_MS - 200, start)).toBe(200);
		expect(reconcileDelay(start + RECONCILE_MAX_WAIT_MS - 4, start)).toBe(4);
	});

	it("returns 0 (fire now) at or past the deadline — never negative", () => {
		expect(reconcileDelay(start + RECONCILE_MAX_WAIT_MS, start)).toBe(0);
		expect(reconcileDelay(start + RECONCILE_MAX_WAIT_MS + 500, start)).toBe(0);
	});

	it("cannot be starved by continuous rescheduling (the original bug)", () => {
		// Simulate partial frames arriving every 16ms, each rescheduling the timer
		// (the pre-fix behavior reset a flat 250ms and never fired). With the
		// max-wait cap the timer must fire within one frame-gap of the deadline.
		const gap = 16;
		let t = start;
		let firedAt: number | null = null;
		while (t < start + 2 * RECONCILE_MAX_WAIT_MS) {
			const delay = reconcileDelay(t, start);
			if (delay < gap) {
				firedAt = t + delay; // timer beats the next reschedule
				break;
			}
			t += gap;
		}
		expect(firedAt).not.toBeNull();
		expect(firedAt!).toBeLessThanOrEqual(start + RECONCILE_MAX_WAIT_MS + gap);
	});
});
