import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

describe("toastsStore", () => {
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	// Read from the store instead of restating the numbers: these are tuning
	// values, and a test that pins them fails on every retune while proving
	// nothing about the dismissal mechanism it means to cover.
	let durations: typeof import("../../stores/toasts").DEFAULT_DURATION_MS;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const mod = await import("../../stores/toasts");
		toastsStore = mod.toastsStore;
		durations = mod.DEFAULT_DURATION_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("adds a toast with default level and no sound", () => {
		testInScope(() => {
			const id = toastsStore.add("Hello");
			expect(toastsStore.toasts).toHaveLength(1);
			expect(toastsStore.toasts[0]).toMatchObject({ id, title: "Hello", message: "", level: "info" });
		});
	});

	it("adds a toast with custom level and message", () => {
		testInScope(() => {
			toastsStore.add("Oops", "something broke", "error");
			expect(toastsStore.toasts[0]).toMatchObject({ title: "Oops", message: "something broke", level: "error" });
		});
	});

	it("removes a toast by id", () => {
		testInScope(() => {
			const id = toastsStore.add("A");
			toastsStore.add("B");
			expect(toastsStore.toasts).toHaveLength(2);
			toastsStore.remove(id);
			expect(toastsStore.toasts).toHaveLength(1);
			expect(toastsStore.toasts[0].title).toBe("B");
		});
	});

	it("auto-dismisses an info toast at its default duration", () => {
		testInScope(() => {
			toastsStore.add("Ephemeral");
			expect(toastsStore.toasts).toHaveLength(1);
			vi.advanceTimersByTime(durations.info - 1);
			expect(toastsStore.toasts).toHaveLength(1); // not a millisecond early
			vi.advanceTimersByTime(1);
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("manual remove clears the auto-dismiss timer (no double-free)", () => {
		testInScope(() => {
			const id = toastsStore.add("Quick");
			toastsStore.remove(id);
			expect(toastsStore.toasts).toHaveLength(0);

			// Advance past the auto-dismiss — must not error or double-remove
			expect(() => vi.advanceTimersByTime(durations.info + 1000)).not.toThrow();
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("auto-dismiss does not fire after manual remove", () => {
		testInScope(() => {
			const id = toastsStore.add("Tmp");
			// Add a second toast to verify it is not affected
			toastsStore.add("Keeper");
			toastsStore.remove(id);
			expect(toastsStore.toasts).toHaveLength(1);
			vi.advanceTimersByTime(durations.info);
			// Both timers fired — Tmp was already removed, Keeper auto-dismissed
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("warn toasts outlive the info window and auto-dismiss at their own", () => {
		testInScope(() => {
			expect(durations.warn).toBeGreaterThan(durations.info); // the point of the level
			toastsStore.add("Careful", "heads up", "warn");
			vi.advanceTimersByTime(durations.info);
			expect(toastsStore.toasts).toHaveLength(1); // still visible past the info window
			vi.advanceTimersByTime(durations.warn - durations.info);
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("error toasts are sticky (never auto-dismiss)", () => {
		testInScope(() => {
			const id = toastsStore.add("Broke", "bad", "error");
			vi.advanceTimersByTime(60000);
			expect(toastsStore.toasts).toHaveLength(1);
			toastsStore.remove(id); // only manual dismissal clears it
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("an explicit duration overrides the per-level default", () => {
		testInScope(() => {
			toastsStore.add("Quick warn", "", "warn", false, undefined, 1000);
			vi.advanceTimersByTime(1000);
			expect(toastsStore.toasts).toHaveLength(0);
		});
	});

	it("accepts sound parameter without error", () => {
		testInScope(() => {
			const id = toastsStore.add("Ding", "", "info", true);
			expect(id).toBeGreaterThan(0);
			expect(toastsStore.toasts).toHaveLength(1);
		});
	});

	it("assigns unique incrementing ids", () => {
		testInScope(() => {
			const id1 = toastsStore.add("First");
			const id2 = toastsStore.add("Second");
			expect(id2).toBe(id1 + 1);
		});
	});

	it("sets createdAt to a recent timestamp", () => {
		testInScope(() => {
			const before = Date.now();
			toastsStore.add("Timed");
			const after = Date.now();
			expect(toastsStore.toasts[0].createdAt).toBeGreaterThanOrEqual(before);
			expect(toastsStore.toasts[0].createdAt).toBeLessThanOrEqual(after);
		});
	});
});

/** A toast fades on its own, usually while the user looks somewhere else. The
 *  mirror is what makes the message readable afterwards, so what matters here is
 *  that the bell item outlives the toast — and that the opt-out really opts out. */
describe("toastsStore — mirroring into the bell", () => {
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	let sectionId: string;
	let durations: typeof import("../../stores/toasts").DEFAULT_DURATION_MS;
	let activityStore: typeof import("../../stores/activityStore").activityStore;
	let notificationsStore: typeof import("../../stores/notifications").notificationsStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const mod = await import("../../stores/toasts");
		toastsStore = mod.toastsStore;
		sectionId = mod.TOAST_ACTIVITY_SECTION_ID;
		durations = mod.DEFAULT_DURATION_MS;
		activityStore = (await import("../../stores/activityStore")).activityStore;
		notificationsStore = (await import("../../stores/notifications")).notificationsStore;
		activityStore.clearAll();
		notificationsStore.setToastsInBell(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("mirrors a toast into the messages section", () => {
		testInScope(() => {
			toastsStore.add("Branch deleted", 'Removed "feature/x"');
			const items = activityStore.getForSection(sectionId);
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				title: "Branch deleted",
				subtitle: 'Removed "feature/x"',
				severity: "info",
				dismissible: true,
			});
		});
	});

	it("preserves repository scope in the mirrored bell item", () => {
		testInScope(() => {
			toastsStore.add("Release published", "tuicommander · v1.7.4", "info", false, undefined, undefined, "/repo");
			expect(activityStore.getForSection(sectionId, "/repo")[0]).toMatchObject({
				title: "Release published",
				repoPath: "/repo",
			});
			expect(activityStore.getForSection(sectionId, "/other")).toHaveLength(0);
		});
	});

	it("keeps the bell item after the toast auto-dismisses", () => {
		testInScope(() => {
			toastsStore.add("Gone in a flash");
			vi.advanceTimersByTime(durations.info + 1);
			expect(toastsStore.toasts).toHaveLength(0);
			expect(activityStore.getForSection(sectionId)).toHaveLength(1);
		});
	});

	it("carries the toast level through as the item severity", () => {
		testInScope(() => {
			toastsStore.add("Careful", "", "warn");
			toastsStore.add("Broke", "", "error");
			const severities = activityStore.getForSection(sectionId).map((i) => i.severity);
			expect(severities).toEqual(["warn", "error"]);
		});
	});

	it("mirrors the toast action as the item click handler", () => {
		testInScope(() => {
			const onClick = vi.fn();
			toastsStore.add("Update ready", "", "info", false, { label: "Install", onClick });
			activityStore.getForSection(sectionId)[0].onClick?.();
			expect(onClick).toHaveBeenCalledOnce();
		});
	});

	it("leaves toasts transient when the setting is off", () => {
		testInScope(() => {
			notificationsStore.setToastsInBell(false);
			toastsStore.add("Unmirrored", "nothing to see later");
			expect(toastsStore.toasts).toHaveLength(1);
			expect(activityStore.getForSection(sectionId)).toHaveLength(0);
		});
	});

	it("resumes mirroring when the setting is turned back on", () => {
		testInScope(() => {
			notificationsStore.setToastsInBell(false);
			toastsStore.add("Skipped");
			notificationsStore.setToastsInBell(true);
			toastsStore.add("Kept");
			const titles = activityStore.getForSection(sectionId).map((i) => i.title);
			expect(titles).toEqual(["Kept"]);
		});
	});
});
