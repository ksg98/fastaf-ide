import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the transport boundary so we drive run/post state transitions with real
// store logic — the invoke mock only stands in for the IPC/HTTP call. What it
// resolves with is the serde shape of `pr_review::PrReviewResult`, so the store
// is exercised against the bytes the backend really sends.
const invokeMock = vi.fn();
vi.mock("../../invoke", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { EGO_MARKER, prReviewStore } from "../../stores/prReview";
import type { PrReviewResult } from "../../types";

const REPO = "/repo";
const PR = 42;

function reviewResult(): PrReviewResult {
	return {
		repo_path: REPO,
		pr_number: PR,
		head_sha: "9f1c0a2b",
		summary: "s",
		files: [
			{
				path: "src/a.ts",
				summary: "A",
				findings: [
					{ path: "src/a.ts", line: 10, hunk: null, severity: "bug", confidence: 0.9, message: "boom" },
					{ path: "src/a.ts", line: null, hunk: null, severity: "nit", confidence: 0.8, message: "meh" },
				],
			},
		],
	};
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

	it("asks the backend for this repo and PR, and for nothing else", async () => {
		invokeMock.mockResolvedValueOnce(reviewResult());
		await prReviewStore.run(REPO, 8);
		// No model, no api key, no provider — the backend picks none of those up
		// either, because ego owns them (criterion 4).
		expect(invokeMock).toHaveBeenCalledWith("run_pr_review", { repoPath: REPO, prNumber: 8 });
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

	it("keeps ego's own sentence instead of a generic failure, and never ends silently empty", async () => {
		// The exact string `acp::oneshot::answer_text` produces when an unattended
		// turn is refused every tool it asks for (criterion 5).
		const egoSays = "ego asked to use 2 tools that an unattended turn cannot grant, and produced no answer";
		invokeMock.mockRejectedValueOnce(egoSays);
		await prReviewStore.run(REPO, 101);
		const entry = prReviewStore.get(REPO, 101);
		expect(entry?.status).toBe("error");
		expect(entry?.error).toContain(egoSays);
		// An error is NOT a review with zero findings.
		expect(entry?.result).toBeNull();
		expect(entry?.selectedIds).toEqual([]);
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

	it("posts each selected finding as one inline comment on the right side", async () => {
		invokeMock.mockResolvedValueOnce(reviewResult());
		await prReviewStore.run(REPO, 33);
		invokeMock.mockResolvedValueOnce(undefined);
		const flat = prReviewStore.get(REPO, 33)?.result?.files[0].findings ?? [];
		await prReviewStore.post(REPO, 33, [{ ...flat[0], id: "x", fileSummary: "A" }]);
		expect(invokeMock).toHaveBeenLastCalledWith("post_pr_review", {
			repoPath: REPO,
			prNumber: 33,
			body: "AI review findings",
			event: "COMMENT",
			comments: [{ path: "src/a.ts", line: 10, side: "RIGHT", body: "boom\n\n<!-- tuic:ego-review -->" }],
		});
	});

	// Catches: the frontend marker drifting from the one the backend counts, so ego
	// threads fall back into the human count with nothing failing.
	it("posts the same ego marker the backend thread split recognises", () => {
		const rust = readFileSync(resolve(__dirname, "../../../src-tauri/crates/tuic-git/src/review_bots/mod.rs"), "utf8");
		expect(rust).toContain(`pub const EGO_MARKER: &str = "${EGO_MARKER}";`);
	});
});
