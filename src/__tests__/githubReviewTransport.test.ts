import { describe, expect, it } from "vitest";
import { mapCommandToHttp } from "../transport";

describe("GitHub line review transport", () => {
	// Catches: browser clients dropping cursors or repository ownership.
	it("preserves thread and comment pagination", () => {
		const threads = mapCommandToHttp("get_pr_line_threads", { repoPath: "/r", prNumber: 7, after: "cursor+1" });
		expect(threads.path).toBe("/repo/pr-line-threads?repoPath=%2Fr&prNumber=7&after=cursor%2B1");
		const comments = mapCommandToHttp("get_pr_thread_comments", { repoPath: "/r", threadId: "t1", after: "c2" });
		expect(comments.path).toBe("/repo/pr-thread-comments?repoPath=%2Fr&threadId=t1&after=c2");
	});
	// Catches: browser clients of "Address Review Comments" reading another repo's PR.
	it("maps the open-threads prompt data to its route", () => {
		expect(mapCommandToHttp("get_pr_open_threads", { repoPath: "/r", prNumber: 7 })).toEqual({
			method: "GET",
			path: "/repo/pr-open-threads?repoPath=%2Fr&prNumber=7",
		});
	});
	// Catches: false resolution state or the reviewed SHA being lost on HTTP.
	it("preserves mutation state and pinned draft", () => {
		expect(mapCommandToHttp("set_pr_thread_resolved", { repoPath: "/r", threadId: "t1", resolved: false })).toEqual({
			method: "POST",
			path: "/repo/pr-thread-resolved",
			body: { repoPath: "/r", threadId: "t1", resolved: false },
		});
		expect(mapCommandToHttp("reply_pr_thread", { repoPath: "/r", threadId: "t1", body: "Reply" }).body).toEqual({
			repoPath: "/r",
			threadId: "t1",
			body: "Reply",
		});
		const draft = { headSha: "abc", event: "COMMENT", body: "Review", comments: [] };
		expect(mapCommandToHttp("submit_pr_draft_review", { repoPath: "/r", prNumber: 7, draft }).body).toEqual({
			repoPath: "/r",
			prNumber: 7,
			draft,
		});
	});
});
