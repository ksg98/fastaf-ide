import { beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { testInScope } from "../helpers/store";

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
