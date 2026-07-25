import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transport boundary so we drive run/post state transitions with real
// store logic — the invoke mock only stands in for the IPC/HTTP call.
const invokeMock = vi.fn();
vi.mock("../../invoke", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import type { FileClassification } from "../../stores/aiTriageStore";
import { prReviewStore } from "../../stores/prReview";

const REPO = "/repo";
const PR = 42;

function reviewResult(): { summary: string; files: FileClassification[]; llm_used: boolean; llm_model: string } {
	const files: FileClassification[] = [
		{
			path: "src/a.ts",
			relevance: "high",
			category: "business-logic",
			risk: "behavioral-change",
			summary: "A",
			source: "llm",
			additions: 1,
			deletions: 0,
			findings: [
				{ path: "src/a.ts", line: 10, hunk: null, severity: "bug", message: "boom", confidence: 0.9 },
				{ path: "src/a.ts", line: null, hunk: null, severity: "nit", message: "meh", confidence: 0.5 },
			],
		},
	];
	return { summary: "s", files, llm_used: true, llm_model: "opus" };
}

describe("prReviewStore", () => {
	beforeEach(() => {
		invokeMock.mockReset();
	});

	it("transitions running → done and seeds all finding ids as selected", async () => {
		invokeMock.mockResolvedValueOnce(reviewResult());
		const p = prReviewStore.run(REPO, PR);
		expect(prReviewStore.get(REPO, PR)?.status).toBe("running");
		await p;
		const entry = prReviewStore.get(REPO, PR);
		expect(entry?.status).toBe("done");
		expect(entry?.result?.files).toHaveLength(1);
		// both findings (line-anchored and file-level) are pre-selected
		expect(entry?.selectedIds).toEqual(["src/a.ts:10:0", "src/a.ts:file:1"]);
	});

	it("captures the result even if the caller stopped awaiting (popover closed)", async () => {
		let resolve!: (v: unknown) => void;
		invokeMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		// Fire-and-forget, mimicking the component unmounting mid-review.
		void prReviewStore.run(REPO, 7);
		expect(prReviewStore.get(REPO, 7)?.status).toBe("running");
		resolve(reviewResult());
		await Promise.resolve();
		await Promise.resolve();
		expect(prReviewStore.get(REPO, 7)?.status).toBe("done");
	});

	it("transitions to error and records the message on failure", async () => {
		invokeMock.mockRejectedValueOnce(new Error("nope"));
		await prReviewStore.run(REPO, 99);
		const entry = prReviewStore.get(REPO, 99);
		expect(entry?.status).toBe("error");
		expect(entry?.error).toContain("nope");
		expect(entry?.result).toBeNull();
	});

	it("ignores a second run while one is already in flight", async () => {
		let resolve!: (v: unknown) => void;
		invokeMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
		void prReviewStore.run(REPO, 5);
		void prReviewStore.run(REPO, 5); // should be a no-op
		expect(invokeMock).toHaveBeenCalledTimes(1);
		resolve(reviewResult());
	});

	it("toggleFinding removes then re-adds an id", async () => {
		invokeMock.mockResolvedValueOnce(reviewResult());
		await prReviewStore.run(REPO, PR);
		prReviewStore.toggleFinding(REPO, PR, "src/a.ts:10:0");
		expect(prReviewStore.get(REPO, PR)?.selectedIds).not.toContain("src/a.ts:10:0");
		prReviewStore.toggleFinding(REPO, PR, "src/a.ts:10:0");
		expect(prReviewStore.get(REPO, PR)?.selectedIds).toContain("src/a.ts:10:0");
	});

	it("post toggles the posting flag and clears it when done", async () => {
		invokeMock.mockResolvedValueOnce(reviewResult());
		await prReviewStore.run(REPO, 21);
		let resolvePost!: (v: unknown) => void;
		invokeMock.mockReturnValueOnce(new Promise((r) => (resolvePost = r)));
		const findings = [{ path: "src/a.ts", line: 10, message: "boom" }] as never[];
		const p = prReviewStore.post(REPO, 21, findings);
		expect(prReviewStore.get(REPO, 21)?.posting).toBe(true);
		resolvePost(undefined);
		await p;
		expect(prReviewStore.get(REPO, 21)?.posting).toBe(false);
	});
});
