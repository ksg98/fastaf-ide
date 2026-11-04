// @vitest-environment jsdom
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ReviewThreadView } from "../../../PrDiffTab/ReviewThreadView";
import type { ReviewThread } from "../../../PrDiffTab/reviewThreads";
import type { ReviewSession } from "../../../PrDiffTab/useReviewSession";
import { TaskComment } from "../TaskComment";

// Shape of the outdated Bugbot thread of PrimeIntellect-ai/verifiers#2833 as the plugins map it.
const author = { id: "cursor", name: "cursor", avatarUrl: null, bot: true };
const comment = {
	id: "c1",
	author,
	body: "Sidecar timeout still scores isolated",
	createdAt: "2026-10-12T19:10:40Z",
	url: null,
};

describe("review authors and outdated threads", () => {
	// Catches: an outdated thread rendered as an open thread at no line, and bot authors shown as people.
	it("tasks_thread_marks_outdated_and_bot", () => {
		const { container } = render(() => (
			<TaskComment
				entry={{
					kind: "review_thread",
					value: {
						id: "t1",
						resolved: false,
						outdated: true,
						path: "verifiers/v1/runtimes/deployment.py",
						line: null,
						originalLine: 148,
						commitId: "head",
						comments: [comment],
						finding: null,
					},
				}}
			/>
		));
		expect(container.querySelector("section > header")?.textContent).toBe(
			"verifiers/v1/runtimes/deployment.py:148 · Outdated · Open thread",
		);
		expect(screen.getByText("bot")).toBeTruthy();
	});

	// Catches: the PR Files tab drops the backend `bot` flag and shows a bot login as a reviewer.
	it("pr_files_thread_marks_bot_author", () => {
		const session = { busyThread: () => null } as unknown as ReviewSession;
		const node = (login: string, bot: boolean) => ({
			id: login,
			body: "text",
			author: { login, bot },
			createdAt: comment.createdAt,
		});
		const thread: ReviewThread = {
			id: "t1",
			path: "a.ts",
			line: 3,
			originalLine: 3,
			diffSide: "RIGHT",
			isResolved: false,
			isOutdated: false,
			comments: {
				pageInfo: { hasNextPage: false, endCursor: null },
				nodes: [node("Copilot", true), node("ulugbekna", false)],
			},
			finding: null,
		};
		const { container } = render(() => <ReviewThreadView thread={thread} session={session} />);
		const headers = [...container.querySelectorAll("article header")].map(
			(h) => h.querySelector("strong + span")?.textContent ?? null,
		);
		expect(headers).toEqual(["bot", null]);
	});
});
