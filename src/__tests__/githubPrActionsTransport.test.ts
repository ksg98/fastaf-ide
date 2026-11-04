import { describe, expect, it } from "vitest";
import { mapCommandToHttp } from "../transport";

describe("GitHub PR action transport", () => {
	// Catches: queue policy reads addressing the wrong repository or PR.
	it("maps action state with repository ownership", () => {
		expect(mapCommandToHttp("get_pr_action_state", { repoPath: "/r", prNumber: 7 })).toEqual({
			method: "GET",
			path: "/repo/pr-action-state?repoPath=%2Fr&prNumber=7",
		});
	});
	// Catches: HTTP dropping reviewed head protection on merge and enable operations.
	it("preserves merge options and head pinning", () => {
		const args = { repoPath: "/r", prNumber: 7, expectedHeadSha: "abc", mergeMethod: "squash" };
		expect(mapCommandToHttp("merge_or_enqueue_pr", args)).toEqual({
			method: "POST",
			path: "/repo/pr-merge-or-enqueue",
			body: args,
		});
		expect(mapCommandToHttp("set_pr_auto_merge", { ...args, enabled: true })).toEqual({
			method: "POST",
			path: "/repo/pr-auto-merge",
			body: { ...args, enabled: true },
		});
	});
	// Catches: false desired states becoming enable/enqueue over HTTP.
	it("preserves disable and dequeue requests", () => {
		expect(mapCommandToHttp("set_pr_auto_merge", { repoPath: "/r", prNumber: 7, enabled: false }).body).toEqual({
			repoPath: "/r",
			prNumber: 7,
			enabled: false,
			mergeMethod: undefined,
			expectedHeadSha: undefined,
		});
		expect(mapCommandToHttp("set_pr_merge_queue", { repoPath: "/r", prNumber: 7, enqueued: false }).body).toEqual({
			repoPath: "/r",
			prNumber: 7,
			enqueued: false,
			expectedHeadSha: undefined,
		});
	});
	// Catches: rerunning a different workflow after losing the selected run id.
	it("preserves the failed workflow run id", () => {
		expect(mapCommandToHttp("rerun_failed_pr_jobs", { repoPath: "/r", runId: 123 })).toEqual({
			method: "POST",
			path: "/repo/pr-rerun-failed",
			body: { repoPath: "/r", runId: 123 },
		});
	});
});
