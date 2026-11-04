import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("1397 critic fix-round notification invariants", () => {
	let store: typeof import("../../stores/toasts").toastsStore;
	let bell: typeof import("../../stores/activityStore").activityStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		store = (await import("../../stores/toasts")).toastsStore;
		bell = (await import("../../stores/activityStore")).activityStore;
		await bell.hydrate();
		bell.clearAll();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("a new grouped member gets its full duration instead of disappearing with the first member", () => {
		// catches: adding at 4.9s leaves only 0.1s to read the new message
		store.add("Saved", "first", "info", false, undefined, 5000);
		vi.advanceTimersByTime(4900);
		store.add("Saved", "second", "info", false, undefined, 5000);
		vi.advanceTimersByTime(4999);
		expect(store.toasts).toHaveLength(1);
		expect(store.toasts[0]).toMatchObject({ message: "second", count: 2 });
		vi.advanceTimersByTime(1);
		expect(store.toasts).toHaveLength(0);
	});

	it("an opted-out card displaced by an error is promoted with a full readable duration", () => {
		// catches: priority replacement loses Progress cards that cannot fall back to Messages
		const progress = store.add("Progress", "Recorded", "info", false, undefined, 2000, undefined, undefined, false);
		const other = store.add("Other", "", "info", false, undefined, 0);
		const error = store.add("Failure", "", "error");
		expect(store.toasts.some((item) => item.id === error)).toBe(true);
		expect(store.toasts.some((item) => item.id === progress)).toBe(false);
		vi.advanceTimersByTime(10000);
		store.remove(other);
		expect(store.toasts.some((item) => item.id === progress)).toBe(true);
		vi.advanceTimersByTime(1999);
		expect(store.toasts.some((item) => item.id === progress)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(store.toasts.some((item) => item.id === progress)).toBe(false);
	});

	it("an incoming error takes a visible slot ahead of two informational cards", () => {
		// catches: the two-card cap hides a failure behind routine success messages
		store.add("First info", "", "info", false, undefined, 0);
		store.add("Second info", "", "info", false, undefined, 0);
		store.add("Failure", "", "error");
		expect(store.toasts).toHaveLength(2);
		expect(store.toasts.some((item) => item.title === "Failure")).toBe(true);
	});

	it("an overflowed error still plays its explicitly requested sound", () => {
		// catches: early overflow return skips the error sound when both slots hold errors
		const start = vi.fn();
		vi.stubGlobal(
			"AudioContext",
			class {
				currentTime = 0;
				destination = {};
				createOscillator() {
					return {
						frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
						connect: (gain: { connect: (destination: unknown) => unknown }) => gain,
						start,
						stop: vi.fn(),
					};
				}
				createGain() {
					return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
				}
			},
		);
		store.add("First error", "", "error");
		store.add("Second error", "", "error");
		store.add("Overflow error", "", "error", true);
		expect(start).toHaveBeenCalledTimes(1);
		expect(bell.getForSection("messages").some((item) => item.title === "Overflow error")).toBe(true);
	});

	it.each([
		{ elapsed: 5000, duplicate: true },
		{ elapsed: 5001, duplicate: false },
	])("bell dedup expires after five seconds ($elapsed ms)", ({ elapsed, duplicate }) => {
		// catches: off-by-one or indefinitely suppressed recurring backend notices
		store.addToBell("Build failed", "same", "error", "/repo", undefined, "session");
		vi.setSystemTime(Date.now() + elapsed);
		const id = store.addToBell("Build failed", "same", "error", "/repo", undefined, "session");
		expect(id === -1).toBe(duplicate);
		expect(bell.getForSection("messages")).toHaveLength(duplicate ? 1 : 2);
	});

	it("identical notices from different sessions keep separate navigation targets", () => {
		// catches: dedup by text alone suppresses a different agent's actionable notice
		store.addToBell("Done", "same", "info", "/repo", undefined, "first");
		store.addToBell("Done", "same", "info", "/repo", undefined, "second");
		expect(bell.getForSection("messages").filter((item) => item.title === "Done")).toHaveLength(2);
	});
});
