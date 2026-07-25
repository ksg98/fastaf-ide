import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the triage-progress listener + stub invoke before importing the store.
// `vi.hoisted` so `listeners` exists when the hoisted vi.mock factory runs.
const mocks = vi.hoisted(() => ({
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue({ summary: null, files: [], llm_used: false, llm_model: null }),
	listen: (event: string, cb: (e: { payload: unknown }) => void) => {
		mocks.listeners.set(event, cb);
		return Promise.resolve(() => {});
	},
}));

import type { FileClassification, Relevance } from "../../stores/aiTriageStore";
import { aiTriageStore } from "../../stores/aiTriageStore";

const REPO = "/repo";

function file(path: string, relevance: Relevance): FileClassification {
	return {
		path,
		relevance,
		category: "business-logic",
		risk: "behavioral-change",
		summary: path,
		source: "heuristic",
		additions: 1,
		deletions: 0,
	};
}

function emit(payload: Record<string, unknown>): void {
	const cb = mocks.listeners.get("triage-progress");
	if (!cb) throw new Error("triage-progress listener not registered");
	cb({ payload });
}

function progress(files: FileClassification[], done: boolean, phase = "heuristic"): Record<string, unknown> {
	return { repo_path: REPO, summary: null, files, phase, done, llm_used: false, llm_model: null };
}

describe("aiTriageStore progress coalescing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		aiTriageStore.clear(REPO);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("buffers streaming events and flushes at most once per interval", () => {
		emit(progress([file("a.ts", "low")], false));
		// Not applied to the store yet — waiting on the flush timer.
		expect(aiTriageStore.getState(REPO).files).toHaveLength(0);

		emit(progress([file("b.ts", "high")], false));
		expect(aiTriageStore.getState(REPO).files).toHaveLength(0);

		vi.advanceTimersByTime(200);
		expect(aiTriageStore.getState(REPO).files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
	});

	it("flushes immediately on done and sorts by relevance only then", () => {
		emit(progress([file("a.ts", "low")], false));
		emit(progress([file("b.ts", "high")], true)); // done → immediate flush + sort
		const files = aiTriageStore.getState(REPO).files;
		expect(files.map((f) => f.path)).toEqual(["b.ts", "a.ts"]); // high before low
		expect(aiTriageStore.getState(REPO).loading).toBe(false);
	});

	it("does not merge a new run onto the previous run's files", () => {
		emit(progress([file("stale.ts", "low")], true));
		expect(aiTriageStore.getState(REPO).files.map((f) => f.path)).toEqual(["stale.ts"]);

		aiTriageStore.clear(REPO); // resets accumulator + store
		emit(progress([file("fresh.ts", "high")], true));
		expect(aiTriageStore.getState(REPO).files.map((f) => f.path)).toEqual(["fresh.ts"]);
	});
});
