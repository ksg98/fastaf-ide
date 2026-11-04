import { beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

describe("githubOpsStore", () => {
	let store: typeof import("../../stores/githubOps").githubOpsStore;

	beforeEach(async () => {
		vi.resetModules();
		store = (await import("../../stores/githubOps")).githubOpsStore;
	});

	it("rejects remote ops that would overwrite a local or other daemon repository with the same path", async () => {
		const { setRepoConnectionLookup } = await import("../../transportRuntime");
		const envelope = {
			repo_path: "/shared",
			payload: { pr_number: 7, done: true },
			__tuic_origin: { connection: "mint" },
		};
		setRepoConnectionLookup(() => undefined);
		store.handleEvent("review-progress", envelope);
		expect(store.getState("/shared").reviews).toEqual({});
		setRepoConnectionLookup(() => "vps");
		store.handleEvent("review-progress", envelope);
		expect(store.getState("/shared").reviews).toEqual({});
		setRepoConnectionLookup(() => "mint");
		store.handleEvent("review-progress", envelope);
		expect(store.getState("/shared").reviews[7].done).toBe(true);
		store.handleEvent("review-progress", { repo_path: "/shared", payload: { pr_number: 7, done: false } });
		expect(store.getState("/shared").reviews[7].done).toBe(true);
	});

	it("returns a clean default for an unknown repo", () => {
		testInScope(() => {
			expect(store.getState("/nope").conflicts).toEqual({});
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

	it("updates an existing conflict in place for the same PR", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: 7, status: "conflicts", conflicted_files: ["x.rs"] },
			});
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: 7, status: "clean", conflicted_files: [] },
			});
			const conflicts = store.getState("/repo1").conflicts;
			expect(Object.keys(conflicts)).toHaveLength(1);
			expect(conflicts[7].status).toBe("clean");
			expect(conflicts[7].conflicted_files).toEqual([]);
		});
	});

	it("isolates state per repo", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: 1, status: "conflicts", conflicted_files: [] },
			});
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo2",
				payload: { pr_number: 2, status: "clean", conflicted_files: [] },
			});
			expect(Object.keys(store.getState("/repo1").conflicts)).toEqual(["1"]);
			expect(Object.keys(store.getState("/repo2").conflicts)).toEqual(["2"]);
		});
	});

	it("ignores an event with no repo_path", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "",
				payload: { pr_number: 99, status: "conflicts", conflicted_files: [] },
			});
			expect(store.getState("").conflicts).toEqual({});
		});
	});

	it("ignores an event whose pr_number is not a number", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: "not-a-number", status: "conflicts", conflicted_files: [] },
			});
			expect(store.getState("/repo1").conflicts).toEqual({});
		});
	});

	it("does not file a null pr_number as PR #0", () => {
		testInScope(() => {
			store.handleEvent("conflict-assist-status", {
				repo_path: "/repo1",
				payload: { pr_number: null, status: "conflicts", conflicted_files: [] },
			});
			expect(store.getState("/repo1").conflicts).toEqual({});
		});
	});

	// ── review-progress (#795-320b) ────────────────────────────────────────────
	// The payloads below are the ones `pr_review::run_pr_review_impl` emits, in
	// the order it emits them.

	it("shows a review as working before ego answers, then done with a count", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 12, done: false, findings_count: 0 },
			});
			expect(store.getState("/repo1").reviews[12]).toMatchObject({ pr_number: 12, done: false, findingsCount: 0 });

			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: 12, done: true, findings_count: 3 },
			});
			expect(store.getState("/repo1").reviews[12]).toMatchObject({ done: true, findingsCount: 3, error: null });
		});
	});

	it("keeps ego's reason on a failed review rather than reporting zero findings", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: {
					pr_number: 4,
					done: true,
					error: "ego could not run this turn: no ego executable is configured",
				},
			});
			const review = store.getState("/repo1").reviews[4];
			expect(review.done).toBe(true);
			expect(review.error).toContain("no ego executable is configured");
			// A missing count is 0, and the error is what tells the two apart.
			expect(review.findingsCount).toBe(0);
		});
	});

	it("ignores a review-progress event whose pr_number is not a number", () => {
		testInScope(() => {
			store.handleEvent("review-progress", {
				repo_path: "/repo1",
				payload: { pr_number: null, done: true, findings_count: 2 },
			});
			expect(store.getState("/repo1").reviews).toEqual({});
		});
	});

	// ── proposals-ready (#795-320b) ────────────────────────────────────────────

	it("takes the proposals off proposals-ready and clears the running flag", () => {
		testInScope(() => {
			store.handleEvent("proposals-ready", {
				repo_path: "/repo1",
				payload: {
					focus: "refactor",
					proposals: [
						{
							title: "Split the parser",
							summary: "It does three jobs",
							rationale: "because",
							issue_title: "Split the parser",
							issue_body: "## Why\n…",
							labels: ["refactor", "parser"],
							impact: "high",
							effort: "medium",
						},
					],
				},
			});
			const state = store.getState("/repo1");
			expect(state.proposals).toHaveLength(1);
			expect(state.proposals[0].title).toBe("Split the parser");
			expect(state.proposals[0].labels).toEqual(["refactor", "parser"]);
			expect(state.improvementScanRunning).toBe(false);
			expect(state.improvementScanError).toBeNull();
		});
	});

	it("drops a proposal that could not file an issue, and keeps the ones that can", () => {
		testInScope(() => {
			store.handleEvent("proposals-ready", {
				repo_path: "/repo1",
				payload: {
					proposals: [
						{ title: "no issue body", issue_title: "t" },
						{ title: "fine", issue_title: "t", issue_body: "b" },
						"not an object",
						null,
					],
				},
			});
			const proposals = store.getState("/repo1").proposals;
			expect(proposals).toHaveLength(1);
			expect(proposals[0].title).toBe("fine");
			// The optional fields fall back rather than arriving undefined.
			expect(proposals[0].labels).toEqual([]);
			expect(proposals[0].impact).toBe("medium");
		});
	});

	it("replaces the previous proposals on a second scan instead of appending", () => {
		testInScope(() => {
			const proposal = (title: string) => ({ title, issue_title: title, issue_body: "b" });
			store.handleEvent("proposals-ready", {
				repo_path: "/repo1",
				payload: { proposals: [proposal("first"), proposal("second")] },
			});
			store.handleEvent("proposals-ready", { repo_path: "/repo1", payload: { proposals: [proposal("third")] } });
			expect(store.getState("/repo1").proposals.map((p) => p.title)).toEqual(["third"]);
		});
	});

	it("treats a scan that found nothing as an empty list, not as a failure", () => {
		testInScope(() => {
			store.handleEvent("proposals-ready", { repo_path: "/repo1", payload: { proposals: [] } });
			const state = store.getState("/repo1");
			expect(state.proposals).toEqual([]);
			expect(state.improvementScanError).toBeNull();
		});
	});
});
