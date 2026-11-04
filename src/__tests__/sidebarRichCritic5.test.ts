import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressFlow } from "../stores/progress";
import { createMinuteClock, subagentRows } from "../utils/sidebarRich";

const NOW = 1_800_000_000_000;
const sub = (id: string, state: "running" | "done", ptyId = "pty") => ({
	id,
	kind: "subagent" as const,
	title: id,
	state,
	toolCalls: 0,
	ptyId,
});
const flow = (participants: ProgressFlow["participants"], events: ProgressFlow["events"] = []): ProgressFlow => ({
	project: "/r",
	participants,
	events,
	truncated: false,
});

describe("subagentRows (critic r5)", () => {
	// Catches: terminal participants (kind "terminal") with the same ptyId listed as their own subagents.
	it("ignores terminal participants sharing the pty id", () => {
		const f = flow([{ ...sub("t", "running"), kind: "terminal" }, sub("s", "running")]);
		expect(subagentRows(f, "pty", NOW).map((r) => r.id)).toEqual(["s"]);
	});

	// Catches: an empty-string session id matching participants whose ptyId is also empty.
	it("returns nothing for an empty session id", () => {
		expect(subagentRows(flow([sub("s", "running", "")]), "", NOW)).toEqual([]);
	});

	// Catches: a failed/closed subagent (any state but running) shown as still running.
	it("treats any non-running state as returned", () => {
		const f = flow([{ ...sub("s", "done"), state: "closed" }]);
		expect(subagentRows(f, "pty", NOW)[0].running).toBe(false);
	});

	// Catches: reordering within the running and returned groups (rows jumping between polls).
	it("keeps flow order inside each group", () => {
		const f = flow([sub("d1", "done"), sub("r1", "running"), sub("d2", "done"), sub("r2", "running")]);
		expect(subagentRows(f, "pty", NOW).map((r) => r.id)).toEqual(["r1", "r2", "d1", "d2"]);
	});

	// Catches: age of a returned subagent read from its spawn event instead of its return event.
	it("uses the return event for a returned subagent and the spawn event for a running one", () => {
		const events = [
			{ id: "a:spawn", atMs: NOW - 3_600_000 },
			{ id: "a:return", atMs: NOW - 120_000 },
			{ id: "b:spawn", atMs: NOW - 180_000 },
		] as ProgressFlow["events"];
		const rows = subagentRows(flow([sub("a", "done"), sub("b", "running")], events), "pty", NOW);
		expect(rows.find((r) => r.id === "a")?.age).toBe("2m");
		expect(rows.find((r) => r.id === "b")?.age).toBe("3m");
	});
});

describe("createMinuteClock (critic r5)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	// Catches: the shared interval cleared when the FIRST consumer disposes while another is still active.
	it("keeps ticking while one consumer remains", () => {
		vi.setSystemTime(NOW);
		let disposeA!: () => void;
		let disposeB!: () => void;
		let clockB!: () => number;
		createRoot((d) => {
			disposeA = d;
			createMinuteClock();
		});
		createRoot((d) => {
			disposeB = d;
			clockB = createMinuteClock();
		});
		disposeA();
		const before = clockB();
		vi.advanceTimersByTime(120_000);
		const after = clockB();
		disposeB();
		expect(after).toBeGreaterThan(before);
	});

	// Catches: the interval leaking after the last consumer disposes.
	it("stops the timer when the last consumer is gone", () => {
		const count = vi.getTimerCount();
		const dispose = createRoot((d) => {
			createMinuteClock();
			return d;
		});
		dispose();
		expect(vi.getTimerCount()).toBe(count);
	});

	// Catches: toggling active off then on leaking a second interval (refcount not restored).
	it("leaves exactly one timer after an inactive/active toggle", () => {
		const before = vi.getTimerCount();
		const [active, setActive] = createSignal(true);
		const dispose = createRoot((d) => {
			createMinuteClock(active);
			return d;
		});
		setActive(false);
		setActive(true);
		expect(vi.getTimerCount()).toBe(before + 1);
		dispose();
		expect(vi.getTimerCount()).toBe(before);
	});

	// Catches: a consumer that joins a running clock reading a time up to a minute old.
	it("hands a late joiner the current time", () => {
		vi.setSystemTime(NOW);
		const disposeFirst = createRoot((d) => {
			createMinuteClock();
			return d;
		});
		vi.setSystemTime(NOW + 50_000);
		let late!: () => number;
		const disposeLate = createRoot((d) => {
			late = createMinuteClock();
			return d;
		});
		const seen = late();
		disposeLate();
		disposeFirst();
		expect(seen).toBe(NOW + 50_000);
	});
});
