import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibilityInterval } from "../utils/visibilityInterval";

/** Swap `document.visibilityState` and fire the matching event. */
function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("createVisibilityInterval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setVisibility("visible");
	});

	afterEach(() => {
		vi.useRealTimers();
		setVisibility("visible");
	});

	it("ticks on the interval while visible", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		vi.advanceTimersByTime(3000);
		expect(tick).toHaveBeenCalledTimes(3);

		dispose();
	});

	it("does not tick while hidden", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		setVisibility("hidden");
		vi.advanceTimersByTime(10_000);
		expect(tick).not.toHaveBeenCalled();

		dispose();
	});

	it("ticks once immediately on becoming visible, then resumes the cadence", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		setVisibility("hidden");
		vi.advanceTimersByTime(10_000);

		setVisibility("visible");
		expect(tick).toHaveBeenCalledTimes(1); // the catch-up tick

		vi.advanceTimersByTime(2000);
		expect(tick).toHaveBeenCalledTimes(3);

		dispose();
	});

	it("a repeated visible event does not stack timers or fire a spurious tick", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		// Already visible: re-announcing it must be inert, or every event would
		// add a second interval and double the tick rate.
		setVisibility("visible");
		setVisibility("visible");
		expect(tick).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(tick).toHaveBeenCalledTimes(1);

		dispose();
	});

	it("a repeated hidden event is inert", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		setVisibility("hidden");
		setVisibility("hidden");
		vi.advanceTimersByTime(10_000);
		expect(tick).not.toHaveBeenCalled();

		dispose();
	});

	it("starts hidden without ticking, then runs once visible", () => {
		setVisibility("hidden");
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		vi.advanceTimersByTime(10_000);
		expect(tick).not.toHaveBeenCalled();

		setVisibility("visible");
		expect(tick).toHaveBeenCalledTimes(1);

		dispose();
	});

	it("dispose stops the timer and detaches the listener", () => {
		const tick = vi.fn();
		const dispose = createRoot((d) => {
			createVisibilityInterval(tick, 1000);
			return d;
		});

		dispose();

		vi.advanceTimersByTime(10_000);
		expect(tick).not.toHaveBeenCalled();

		// A visibility change after cleanup must not resurrect the timer.
		setVisibility("hidden");
		setVisibility("visible");
		vi.advanceTimersByTime(10_000);
		expect(tick).not.toHaveBeenCalled();
	});
});
