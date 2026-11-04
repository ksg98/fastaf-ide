import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

describe("toastsStore critic 1397", () => {
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	let activityStore: typeof import("../../stores/activityStore").activityStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		toastsStore = (await import("../../stores/toasts")).toastsStore;
		activityStore = (await import("../../stores/activityStore")).activityStore;
		await activityStore.hydrate();
		activityStore.clearAll();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const reachable = (title: string) =>
		toastsStore.toasts.some((t) => t.title === title) || activityStore.getActive().some((i) => i.title === title);

	it("a bell-opted-out toast raised while two cards are visible is not silently lost", () => {
		// catches: overflow path drops a mirrorInBell=false toast (Progress outcome) — neither card nor bell item
		testInScope(() => {
			toastsStore.add("A", "", "info", false, undefined, 0);
			toastsStore.add("B", "", "info", false, undefined, 0);
			toastsStore.add("Progress", "Recorded", "info", false, undefined, undefined, "/repo", undefined, false);
			expect(reachable("Progress")).toBe(true);
		});
	});

	it("two identical backend notices in a row leave one bell item", () => {
		// catches: removal of the hasVisible dedup — a duplicated mcp-toast event stacks copies in the bell
		testInScope(() => {
			toastsStore.addToBell("Dup", "same", "info", "/repo");
			toastsStore.addToBell("Dup", "same", "info", "/repo");
			expect(activityStore.getActive().filter((i) => i.title === "Dup")).toHaveLength(1);
		});
	});

	it("a same-kind toast exactly 5000 ms after the first joins its group", () => {
		// catches: off-by-one in the 5 s coalescing window (< instead of <=)
		testInScope(() => {
			toastsStore.add("Saved", "one", "info", false, undefined, 0);
			toastsStore.add("Other", "x", "info", false, undefined, 0);
			vi.advanceTimersByTime(5000);
			toastsStore.add("Saved", "two", "info", false, undefined, 0);
			expect(toastsStore.toasts).toHaveLength(2);
			expect(toastsStore.toasts.find((t) => t.title === "Saved")?.count).toBe(2);
		});
	});

	it("a grouped toast that is dismissed starts a fresh count next time", () => {
		// catches: count surviving removal, so the next Saved shows ×3 instead of a plain card
		testInScope(() => {
			const id = toastsStore.add("Saved", "one", "info", false, undefined, 0);
			toastsStore.add("Saved", "two", "info", false, undefined, 0);
			toastsStore.remove(id);
			toastsStore.add("Saved", "three", "info", false, undefined, 0);
			expect(toastsStore.toasts).toHaveLength(1);
			expect(toastsStore.toasts[0].count).toBeUndefined();
		});
	});
});

describe("toastsStore critic 1397 round 2", () => {
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	let activityStore: typeof import("../../stores/activityStore").activityStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		toastsStore = (await import("../../stores/toasts")).toastsStore;
		activityStore = (await import("../../stores/activityStore")).activityStore;
		await activityStore.hydrate();
		activityStore.clearAll();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("the same agent notice ten minutes later is announced again", () => {
		// catches: dedup keyed only on 'still in the bell' — a repeated failure an hour later is swallowed with its sound
		testInScope(() => {
			expect(toastsStore.addToBell("Build failed", "x", "error", "/repo", undefined, "s1")).not.toBe(-1);
			vi.advanceTimersByTime(10 * 60_000);
			expect(toastsStore.addToBell("Build failed", "x", "error", "/repo", undefined, "s1")).not.toBe(-1);
		});
	});

	it("an error that displaces an info card gives it back when the error is dismissed", () => {
		// catches: displaced card lost for good, or queue never pumped on remove
		testInScope(() => {
			toastsStore.add("I1", "", "info", false, undefined, 0);
			toastsStore.add("I2", "", "info", false, undefined, 0);
			const err = toastsStore.add("Boom", "", "error");
			expect(toastsStore.toasts.some((t) => t.title === "Boom")).toBe(true);
			expect(toastsStore.toasts).toHaveLength(2);
			toastsStore.remove(err);
			expect(toastsStore.toasts.map((t) => t.title).sort()).toEqual(["I1", "I2"]);
		});
	});

	it("an error is not both shown and duplicated into the bell", () => {
		// catches: error that takes a visible slot is also force-mirrored as if it had overflowed
		testInScope(() => {
			toastsStore.add("I1", "", "info", false, undefined, 0);
			toastsStore.add("I2", "", "info", false, undefined, 0);
			const before = activityStore.getActive().filter((i) => i.title === "Boom").length;
			toastsStore.add("Boom", "", "error");
			expect(activityStore.getActive().filter((i) => i.title === "Boom").length - before).toBeLessThanOrEqual(1);
		});
	});
});

describe("toastsStore critic 1397 round 3", () => {
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	let activityStore: typeof import("../../stores/activityStore").activityStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		toastsStore = (await import("../../stores/toasts")).toastsStore;
		activityStore = (await import("../../stores/activityStore")).activityStore;
		await activityStore.hydrate();
		activityStore.clearAll();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("an identical notice at exactly 5000 ms is still a duplicate, at 5001 ms it is new", () => {
		// catches: off-by-one in the bell dedup window (< vs <=) or a window that slides with every suppressed repeat
		testInScope(() => {
			toastsStore.addToBell("N", "m", "info", "/repo", undefined, "s1");
			vi.advanceTimersByTime(5000);
			expect(toastsStore.addToBell("N", "m", "info", "/repo", undefined, "s1")).toBe(-1);
			vi.advanceTimersByTime(1);
			expect(toastsStore.addToBell("N", "m", "info", "/repo", undefined, "s1")).not.toBe(-1);
		});
	});

	it("a different session raising the same notice within the window is not deduplicated", () => {
		// catches: dedup ignoring sessionId, hiding a second agent's notice
		testInScope(() => {
			toastsStore.addToBell("N", "m", "info", "/repo", undefined, "s1");
			expect(toastsStore.addToBell("N", "m", "info", "/repo", undefined, "s2")).not.toBe(-1);
		});
	});
});
