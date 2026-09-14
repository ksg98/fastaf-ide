import { beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope, testInScopeAsync } from "../helpers/store";
import { mockInvoke } from "../mocks/tauri";

describe("githubOpsStore", () => {
	let store: typeof import("../../stores/githubOps").githubOpsStore;

	beforeEach(async () => {
		vi.resetModules();
		store = (await import("../../stores/githubOps")).githubOpsStore;
	});

	it("returns a clean default for an unknown repo", () => {
		testInScope(() => {
			const state = store.getState("/nope");
			expect(state.reviews).toEqual({});
			expect(state.conflicts).toEqual({});
			expect(state.proposals).toEqual([]);
			expect(state.lastChangelogAt).toBeNull();
			expect(state.improvementScanRunning).toBe(false);
			expect(state.improvementScanError).toBeNull();
		});
	});

	it("records a review-progress event for a pr_number", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 42, files: ["a.ts", "b.ts"], phase: "analyzing", done: false },
			});
			const review = store.getState("/repo1").reviews[42];
			expect(review).toBeDefined();
			expect(review.pr_number).toBe(42);
			expect(review.findingsCount).toBe(2);
			expect(review.phase).toBe("analyzing");
			expect(review.done).toBe(false);
		});
	});

	/**
	 * The backend sends `files` as a COUNT, not the classification vector: the
	 * event fires per classified file and this store reads nothing but the
	 * length. The array form is still accepted so a new client keeps working
	 * against an older backend.
	 */
	it("accepts a numeric files count from the backend", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 7, files: 12, phase: "analyzing", done: false },
			});
			expect(store.getState("/repo1").reviews[7].findingsCount).toBe(12);
		});
	});

	it("updates an existing review in place for the same PR", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 42, files: ["a.ts"], phase: "analyzing", done: false },
			});
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 42, files: ["a.ts", "b.ts", "c.ts"], phase: "reporting", done: true },
			});
			const reviews = store.getState("/repo1").reviews;
			// Still a single entry, updated in place.
			expect(Object.keys(reviews)).toHaveLength(1);
			expect(reviews[42].findingsCount).toBe(3);
			expect(reviews[42].phase).toBe("reporting");
			expect(reviews[42].done).toBe(true);
		});
	});

	it("populates conflicts from conflict-assist-status", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: 7, status: "conflicts", conflicted_files: ["x.rs", "y.rs"] },
			});
			const conflict = store.getState("/repo1").conflicts[7];
			expect(conflict).toBeDefined();
			expect(conflict.pr_number).toBe(7);
			expect(conflict.status).toBe("conflicts");
			expect(conflict.conflicted_files).toEqual(["x.rs", "y.rs"]);
		});
	});

	it("isolates state per repo", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 1, files: [], phase: "start", done: false },
			});
			store.handleEvent("review-progress", {
				repo_path: "/repo2",
				payload: { pr_number: 2, files: [], phase: "start", done: false },
			});
			expect(Object.keys(store.getState("/repo1").reviews)).toEqual(["1"]);
			expect(Object.keys(store.getState("/repo2").reviews)).toEqual(["2"]);
			// repo1 has no conflicts from repo2's activity.
			expect(store.getState("/repo1").conflicts).toEqual({});
		});
	});

	it("records changelog-done timestamp", () => {
		testInScope(() => {
			expect(store.getState("/repo1").lastChangelogAt).toBeNull();
			store.handleEvent("changelog-done", { repo_path: "/repo1", payload: {} });
			expect(store.getState("/repo1").lastChangelogAt).toBeGreaterThan(0);
		});
	});

	it("records typed proposals from proposals-ready", () => {
		testInScope(() => {
			store.handleEvent("proposals-ready", {
				repo_path: "/repo1",
				payload: {
					proposals: [
						{
							title: "Add focused tests",
							summary: "Cover the retry path",
							rationale: "It regressed before",
							issue_title: "Add retry tests",
							issue_body: "Acceptance:\n- tests cover retries",
							labels: ["testing"],
							impact: "medium",
							effort: "small",
						},
					],
				},
			});
			const proposals = store.getState("/repo1").proposals;
			expect(proposals).toHaveLength(1);
			expect(proposals[0].issue_title).toBe("Add retry tests");
			expect(proposals[0].labels).toEqual(["testing"]);
		});
	});

	// A scan used to publish its proposals twice: once from the invoke's return
	// value and once from the `proposals-ready` event the backend emits just
	// before returning. The event is the path that has to exist — it reaches
	// every window and both transports — so the return value must not write.
	it("does not publish proposals from the scan's return value", async () => {
		mockInvoke.mockResolvedValueOnce({
			proposals: [
				{
					title: "From the return value",
					summary: "s",
					rationale: "r",
					issue_title: "Should not appear",
					issue_body: "b",
					labels: [],
					impact: "medium",
					effort: "small",
				},
			],
		});

		await testInScopeAsync(async () => {
			const result = await store.runImprovementScan("/repo1", "testing");
			// The caller still gets the result…
			expect(result.proposals).toHaveLength(1);
			// …but the store waits for the event.
			expect(store.getState("/repo1").proposals).toEqual([]);
		});
	});

	it("ignores events with no repo_path", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "",
				payload: { pr_number: 99, files: [], phase: "x", done: false },
			});
			expect(store.getState("").reviews).toEqual({});
		});
	});
});
