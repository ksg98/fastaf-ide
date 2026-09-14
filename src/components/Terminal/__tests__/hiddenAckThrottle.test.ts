import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHiddenAckThrottle } from "../canvasTerminalUtils";

/**
 * A hidden terminal still receives frames (the bell rides in the header) but must
 * not reopen the delivery gate at full rate for a viewport nobody can see. It
 * cannot simply stay silent either: an unacked frame leaves the gate closed until
 * the backend ticker gives up on it 500 ms later, which is a warning per burst.
 *
 * So it acks late and rarely — one trailing ack per interval, below the backend's
 * force-reset deadline.
 */
describe("createHiddenAckThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not ack the frame that scheduled it", () => {
		const ack = vi.fn();
		createHiddenAckThrottle(ack, 400).schedule();

		expect(ack).not.toHaveBeenCalled();
		vi.advanceTimersByTime(399);
		expect(ack).not.toHaveBeenCalled();
	});

	it("acks once the interval has elapsed", () => {
		const ack = vi.fn();
		createHiddenAckThrottle(ack, 400).schedule();

		vi.advanceTimersByTime(400);
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("collapses a burst of frames into a single ack", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 400);

		// A hidden agent tab repainting at the ticker rate: 30 frames over 480 ms,
		// which spans the 400 ms interval once.
		for (let i = 0; i < 30; i++) {
			throttle.schedule();
			vi.advanceTimersByTime(16);
		}
		expect(ack).toHaveBeenCalledTimes(1);
	});

	it("arms again for frames that arrive after an ack", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 400);

		throttle.schedule();
		vi.advanceTimersByTime(400);
		expect(ack).toHaveBeenCalledTimes(1);

		throttle.schedule();
		vi.advanceTimersByTime(400);
		expect(ack).toHaveBeenCalledTimes(2);
	});

	it("cancels a pending ack on teardown", () => {
		// The ack targets a session that is being unsubscribed or resubscribed;
		// firing afterwards talks about a frame counter that no longer applies.
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 400);

		throttle.schedule();
		throttle.cancel();
		vi.advanceTimersByTime(2000);
		expect(ack).not.toHaveBeenCalled();
	});

	it("can be re-armed after a cancel", () => {
		const ack = vi.fn();
		const throttle = createHiddenAckThrottle(ack, 400);

		throttle.schedule();
		throttle.cancel();
		throttle.schedule();
		vi.advanceTimersByTime(400);
		expect(ack).toHaveBeenCalledTimes(1);
	});
});
