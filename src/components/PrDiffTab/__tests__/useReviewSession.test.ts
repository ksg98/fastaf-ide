import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";
import { mockInvoke } from "../../../__tests__/mocks/tauri";
import type { ReviewThread } from "../reviewThreads";
import { createReviewSession } from "../useReviewSession";
import { recordedPr } from "./recorded";

const { headSha, threads } = recordedPr(340803);
const open = threads.find((t) => !t.isOutdated && !t.isResolved) as ReviewThread;
const page = (head = headSha, nodes = threads, more = false) => ({
	headSha: head,
	threads: nodes,
	hasNextPage: more,
	endCursor: more ? "c1" : null,
});

const session = () => createRoot(() => createReviewSession("/repo", 340803));

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
});

describe("createReviewSession", () => {
	// Catches: threads past the first page silently dropped.
	it("reads every thread page and pins the first head", async () => {
		mockInvoke
			.mockResolvedValueOnce(page(headSha, threads.slice(0, 2), true))
			.mockResolvedValueOnce(page(headSha, threads.slice(2)));
		const s = session();
		await s.refresh();
		expect(s.threads()).toHaveLength(threads.length);
		expect(mockInvoke).toHaveBeenNthCalledWith(2, "get_pr_line_threads", {
			repoPath: "/repo",
			prNumber: 340803,
			after: "c1",
		});
		expect(s.headSha()).toBe(headSha);
	});

	// Catches: UI-only resolution.
	it("changes thread state only from the backend's confirmed thread", async () => {
		const s = session();
		mockInvoke.mockResolvedValueOnce(page());
		await s.refresh();
		mockInvoke.mockRejectedValueOnce(new Error("GitHub did not confirm the requested thread resolution"));
		await s.setResolved(open.id, true);
		expect(s.threads().find((t) => t.id === open.id)?.isResolved).toBe(false);
		expect(s.error()).toContain("did not confirm");
		mockInvoke.mockResolvedValueOnce({ ...open, isResolved: true });
		await s.setResolved(open.id, true);
		expect(mockInvoke).toHaveBeenLastCalledWith("set_pr_thread_resolved", {
			repoPath: "/repo",
			threadId: open.id,
			resolved: true,
		});
		expect(s.threads().find((t) => t.id === open.id)?.isResolved).toBe(true);
	});

	// Catches: a reply shown that GitHub never accepted.
	it("appends a reply only after the backend returns the posted comment", async () => {
		const s = session();
		mockInvoke.mockResolvedValueOnce(page());
		await s.refresh();
		const before = s.threads().find((t) => t.id === open.id)?.comments.nodes.length;
		mockInvoke.mockRejectedValueOnce(new Error("HTTP 502"));
		expect(await s.reply(open.id, "Thanks")).toBe(false);
		expect(s.threads().find((t) => t.id === open.id)?.comments.nodes).toHaveLength(before ?? -1);
		mockInvoke.mockResolvedValueOnce({
			id: "new",
			body: "Thanks",
			author: { login: "me" },
			createdAt: "2026-10-11T10:00:00Z",
		});
		expect(await s.reply(open.id, "Thanks")).toBe(true);
		expect(
			s
				.threads()
				.find((t) => t.id === open.id)
				?.comments.nodes.at(-1)?.id,
		).toBe("new");
	});

	// Catches: replies past the first 100 silently dropped.
	it("loads further replies from the cursor", async () => {
		const long = { ...open, comments: { ...open.comments, pageInfo: { hasNextPage: true, endCursor: "r1" } } };
		mockInvoke.mockResolvedValueOnce(page(headSha, [long]));
		const s = session();
		await s.refresh();
		mockInvoke.mockResolvedValueOnce({
			pageInfo: { hasNextPage: false, endCursor: null },
			nodes: [{ id: "r2", body: "late", author: null, createdAt: "2026-10-11T10:00:00Z" }],
		});
		await s.loadMoreComments(open.id);
		expect(mockInvoke).toHaveBeenLastCalledWith("get_pr_thread_comments", {
			repoPath: "/repo",
			threadId: open.id,
			after: "r1",
		});
		expect(s.threads()[0].comments.nodes.at(-1)?.id).toBe("r2");
		expect(s.threads()[0].comments.pageInfo.hasNextPage).toBe(false);
	});

	// Catches: comments on lines of a stale SHA being submitted or even queued.
	it("draft_review_rejected_when_head_moved: keeps the drafts, flags the move and refuses new drafts", async () => {
		mockInvoke.mockResolvedValueOnce(page());
		const s = session();
		await s.refresh();
		s.addDraft({ path: "a.ts", line: 4, side: "RIGHT", body: "Nit" });
		mockInvoke.mockRejectedValueOnce(
			new Error("review-head-changed: Refresh and review the new commits before submitting"),
		);
		expect(await s.submit("Summary", "COMMENT")).toBe(false);
		expect(mockInvoke).toHaveBeenLastCalledWith("submit_pr_draft_review", {
			repoPath: "/repo",
			prNumber: 340803,
			draft: {
				headSha,
				body: "Summary",
				event: "COMMENT",
				comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "Nit" }],
			},
		});
		expect(s.headMoved()).toBe(true);
		expect(s.drafts()).toHaveLength(1);
		s.addDraft({ path: "a.ts", line: 5, side: "RIGHT", body: "Another" });
		expect(s.drafts()).toHaveLength(1);
	});

	// Catches: a refresh at a newer head silently re-pinning drafts to lines of the older diff.
	it("flags a head change seen on refresh instead of re-pinning", async () => {
		mockInvoke.mockResolvedValueOnce(page());
		const s = session();
		await s.refresh();
		mockInvoke.mockResolvedValueOnce(page("f".repeat(40)));
		await s.refresh();
		expect(s.headSha()).toBe(headSha);
		expect(s.headMoved()).toBe(true);
	});

	// Catches: drafts kept after GitHub accepted the review (double submission).
	it("clears the drafts and rereads threads after a confirmed submission", async () => {
		mockInvoke.mockResolvedValueOnce(page());
		const s = session();
		await s.refresh();
		s.addDraft({ path: "a.ts", line: 4, side: "LEFT", body: "Nit" });
		mockInvoke.mockResolvedValueOnce({ id: 1, url: "u", state: "COMMENTED" }).mockResolvedValueOnce(page());
		expect(await s.submit("", "COMMENT")).toBe(true);
		expect(s.drafts()).toEqual([]);
		expect(mockInvoke).toHaveBeenLastCalledWith("get_pr_line_threads", {
			repoPath: "/repo",
			prNumber: 340803,
			after: null,
		});
	});
});
