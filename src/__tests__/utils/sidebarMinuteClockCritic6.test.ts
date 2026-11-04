import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMinuteClock } from "../../utils/sidebarRich";

describe("createMinuteClock (critic r6)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	// Catches: a row mounted mid-minute reading the time of the last tick, so its age is up to 59s old.
	it("gives a late joiner the current time, not the last tick", () => {
		let disposeA!: () => void;
		let disposeB!: () => void;
		createRoot((d) => {
			disposeA = d;
			createMinuteClock();
		});
		vi.advanceTimersByTime(40_000);
		let nowB!: () => number;
		createRoot((d) => {
			disposeB = d;
			nowB = createMinuteClock();
		});
		expect(nowB()).toBe(Date.now());
		disposeA();
		disposeB();
	});

	// Catches: a row going inactive then active again keeping the stale time from before it left.
	it("refreshes the time when a caller becomes active again", () => {
		const [active, setActive] = createSignal(true);
		let now!: () => number;
		let dispose!: () => void;
		createRoot((d) => {
			dispose = d;
			now = createMinuteClock(active);
		});
		setActive(false);
		vi.advanceTimersByTime(30_000);
		setActive(true);
		expect(now()).toBe(Date.now());
		dispose();
	});

	// Catches: the interval leaking after the last user leaves, or dying while one user remains.
	it("keeps one interval while any caller is live and none after the last leaves", () => {
		let disposeA!: () => void;
		let disposeB!: () => void;
		createRoot((d) => {
			disposeA = d;
			createMinuteClock();
		});
		createRoot((d) => {
			disposeB = d;
			createMinuteClock();
		});
		expect(vi.getTimerCount()).toBe(1);
		disposeA();
		expect(vi.getTimerCount()).toBe(1);
		disposeB();
		expect(vi.getTimerCount()).toBe(0);
	});

	// Catches: the interval not restarting for a caller that joins after everyone left.
	it("restarts ticking for a caller that joins after the clock stopped", () => {
		let d1!: () => void;
		createRoot((d) => {
			d1 = d;
			createMinuteClock();
		});
		d1();
		let now!: () => number;
		let d2!: () => void;
		createRoot((d) => {
			d2 = d;
			now = createMinuteClock();
		});
		const before = now();
		vi.advanceTimersByTime(60_000);
		expect(now()).toBeGreaterThan(before);
		d2();
	});
});
