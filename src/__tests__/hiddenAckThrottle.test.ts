import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BACKEND_FRAME_ABANDON_MS,
	createHiddenAckThrottle,
	HIDDEN_ACK_INTERVAL_MS,
} from "../components/Terminal/canvasTerminalUtils";

describe("hidden ack interval", () => {
	// The regression this file exists for: a hidden tab acks on a main-thread
	// setTimeout while the backend times the same frame on its own clock. The gap
	// between the two constants is the only drift budget there is, and at 400 vs
	// 500 ms it was routinely lost — `grid frame gate stuck` fired every few
	// seconds with elapsed_ms 506-508 for tabs that were simply in the background.
	it("leaves the frontend enough drift budget to beat the backend deadline", () => {
		const budget = BACKEND_FRAME_ABANDON_MS - HIDDEN_ACK_INTERVAL_MS;
		expect(budget).toBeGreaterThanOrEqual(300);
	});

	it("still acks well inside the deadline, so the gate reopens on the ack", () => {
		expect(HIDDEN_ACK_INTERVAL_MS).toBeLessThan(BACKEND_FRAME_ABANDON_MS);
	});
});

describe("createHiddenAckThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("acks once for a burst of frames, not once per frame", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		for (let i = 0; i < 50; i++) throttle.schedule();
		expect(ack).not.toHaveBeenCalled();

		vi.advanceTimersByTime(200);
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("keeps acking through a steady stream — a debounce would starve the gate", () => {
		// A hidden agent tab repainting at the ticker rate: 30 frames over 480 ms.
		// Restarting the timer on every frame would never fire inside that stream.
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 400);

		for (let i = 0; i < 30; i++) {
			throttle.schedule();
			vi.advanceTimersByTime(16);
		}
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("acks late rather than never — a silent gate is what the ticker punishes", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		throttle.schedule();
		vi.advanceTimersByTime(199);
		expect(ack).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("re-arms after firing so a hidden tab keeps draining, not just once", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		throttle.schedule();
		vi.advanceTimersByTime(200);
		throttle.schedule();
		vi.advanceTimersByTime(200);

		expect(ack).toHaveBeenCalledTimes(2);
	});

	it("drops a pending ack on cancel — a resubscribe resets the count Rust expects", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		throttle.schedule();
		throttle.cancel();
		vi.advanceTimersByTime(1000);

		expect(ack).not.toHaveBeenCalled();
	});

	it("can be re-armed after a cancel", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		throttle.schedule();
		throttle.cancel();
		throttle.schedule();
		vi.advanceTimersByTime(200);

		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("tolerates a cancel with nothing pending", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 200);

		expect(() => {
			throttle.cancel();
		}).not.toThrow();
		vi.advanceTimersByTime(1000);
		expect(ack).not.toHaveBeenCalled();
	});
});
