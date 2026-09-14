import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeadingThrottle } from "../canvasTerminalUtils";

describe("createLeadingThrottle", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("runs the first trigger immediately", () => {
		const run = vi.fn();
		createLeadingThrottle(run, 150).trigger();
		expect(run).toHaveBeenCalledTimes(1);
	});

	/**
	 * The reason this exists. A redrawing TUI emits frames every ~16 ms, and a
	 * trailing debounce clears its timer on each one — so the search never
	 * refreshed at all while the screen was busy, which is exactly when its
	 * matches go stale. Leading-edge keeps it live and still bounded.
	 */
	it("keeps refreshing under a trigger stream faster than the interval", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		for (let elapsed = 0; elapsed < 600; elapsed += 16) {
			throttle.trigger();
			vi.advanceTimersByTime(16);
		}
		expect(run.mock.calls.length).toBeGreaterThan(1);
	});

	it("runs at most once per interval", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		for (let i = 0; i < 20; i++) {
			throttle.trigger();
			vi.advanceTimersByTime(10);
		}
		// 200 ms of triggers: the leading run plus at most one per interval.
		expect(run.mock.calls.length).toBeLessThanOrEqual(3);
	});

	it("still runs once for triggers that arrive inside the window", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		throttle.trigger();
		expect(run).toHaveBeenCalledTimes(1);
		throttle.trigger();
		throttle.trigger();
		expect(run).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(150);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not fire a trailing run when nothing was triggered in the window", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		throttle.trigger();
		vi.advanceTimersByTime(1000);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("opens a fresh window after an idle gap", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		throttle.trigger();
		vi.advanceTimersByTime(1000);
		throttle.trigger();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("cancel drops a pending run", () => {
		const run = vi.fn();
		const throttle = createLeadingThrottle(run, 150);
		throttle.trigger();
		throttle.trigger();
		throttle.cancel();
		vi.advanceTimersByTime(1000);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
