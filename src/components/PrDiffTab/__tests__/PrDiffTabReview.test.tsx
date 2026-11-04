import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../../../__tests__/mocks/tauri";

vi.mock("@tanstack/solid-virtual", () => ({
	createVirtualizer: (opts: { count: number }) => ({
		getTotalSize: () => opts.count * 100,
		getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 100 })),
		measureElement: () => {},
	}),
}));

// The real viewer measures text on a canvas. This stand-in honours the library contract
// the tab relies on: annotations come through extendData and are drawn by renderExtendLine.
vi.mock("../../ui/DiffViewer", async (orig) => ({
	...(await orig<typeof import("../../ui/DiffViewer")>()),
	DiffViewer: (props: import("../../ui/DiffViewer").DiffViewerProps) => {
		const entries = () =>
			(["oldFile", "newFile"] as const).flatMap((side) =>
				Object.entries(props.extendData?.[side] ?? {}).map(([line, e]) => ({ side, line, data: e?.data })),
			);
		return (
			<div data-testid="viewer">
				{entries().map((e) => (
					<div data-line={`${e.side}:${e.line}`}>
						{props.renderExtendLine?.({
							lineNumber: Number(e.line),
							side: e.side === "oldFile" ? 1 : 2,
							data: e.data,
							diffFile: {} as never,
							onUpdate: () => {},
						})}
					</div>
				))}
				<button type="button" onClick={() => {}} data-widget={props.diffViewAddWidget ? "on" : "off"}>
					gutter
				</button>
				<div data-testid="widget">
					{props.renderWidgetLine?.({ lineNumber: 2, side: 2, diffFile: {} as never, onClose: () => {} })}
				</div>
			</div>
		);
	},
}));

import { PrDiffTab } from "../PrDiffTab";
import type { ReviewThread } from "../reviewThreads";
import { recordedPr } from "./recorded";

const { headSha, threads } = recordedPr(340803);
const live = threads.find((t) => !t.isOutdated && !t.isResolved) as ReviewThread;
const outdated = threads.find((t) => t.isOutdated) as ReviewThread;
const fileDiff = (path: string) =>
	`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;
const DIFF = [live.path, outdated.path]
	.filter((p, i, all) => all.indexOf(p) === i)
	.map(fileDiff)
	.join("\n");

const respond = (overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) =>
	mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		if (overrides[cmd]) return overrides[cmd](args);
		if (cmd === "get_pr_line_threads") return { headSha, threads, hasNextPage: false, endCursor: null };
		return undefined;
	});

beforeEach(() => {
	mockInvoke.mockReset();
	respond();
});

describe("PrDiffTab review threads", () => {
	// Catches: an outdated thread attached to a wrong current line instead of labelled outdated.
	it("outdated_thread_shown_as_outdated: labels it and keeps it off the diff lines", async () => {
		const { container, findAllByText } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findAllByText("Outdated");
		const outdatedCard = container.querySelector(`[data-thread-id="${outdated.id}"]`);
		expect(outdatedCard).toBeTruthy();
		expect(outdatedCard?.closest("[data-line]")).toBeNull();
		const liveCard = container.querySelector(`[data-thread-id="${live.id}"]`);
		expect(liveCard?.closest("[data-line]")?.getAttribute("data-line")).toBe(`newFile:${live.line}`);
		expect(liveCard?.textContent).not.toContain("Outdated");
	});

	// Catches: UI-only resolution — the card must flip because the backend answered, with its state.
	it("resolve_updates_thread_state: sends the mutation and shows the returned state", async () => {
		respond({ set_pr_thread_resolved: () => ({ ...live, isResolved: true }) });
		const { container, findByText } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findByText("Resolve");
		const card = () => container.querySelector(`[data-thread-id="${live.id}"]`) as HTMLElement;
		fireEvent.click(Array.from(card().querySelectorAll("button")).find((b) => b.textContent === "Resolve") as Element);
		await waitFor(() => expect(card().textContent).toContain("Unresolve"));
		expect(mockInvoke).toHaveBeenCalledWith("set_pr_thread_resolved", {
			repoPath: "/repo",
			threadId: live.id,
			resolved: true,
		});
	});

	// Catches: a rejected mutation leaving the card flipped.
	it("keeps the thread open and shows the failure when the backend rejects resolution", async () => {
		respond({
			set_pr_thread_resolved: () => {
				throw new Error("GitHub did not confirm the requested thread resolution");
			},
		});
		const { container, findByText, findByRole } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findByText("Resolve");
		const card = container.querySelector(`[data-thread-id="${live.id}"]`) as HTMLElement;
		fireEvent.click(Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Resolve") as Element);
		expect((await findByRole("alert")).textContent).toContain("did not confirm");
		expect(card.textContent).not.toContain("Unresolve");
	});

	// Catches: a reply typed but never sent, or sent to another thread.
	it("posts a reply to its own thread and clears the box on success", async () => {
		respond({
			reply_pr_thread: () => ({
				id: "c-new",
				body: "Done",
				author: { login: "me" },
				createdAt: "2026-10-11T10:00:00Z",
			}),
		});
		const { container, findByText } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findByText("Resolve");
		const card = container.querySelector(`[data-thread-id="${live.id}"]`) as HTMLElement;
		const box = card.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.input(box, { target: { value: "Done" } });
		const replyButton = Array.from(card.querySelectorAll("button")).find(
			(b) => b.textContent === "Reply",
		) as HTMLButtonElement;
		fireEvent.click(replyButton);
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("reply_pr_thread", expect.anything()));
		const current = () => container.querySelector(`[data-thread-id="${live.id}"]`) as HTMLElement;
		await waitFor(() => expect(current().textContent).toContain("Done"));
		expect(mockInvoke).toHaveBeenCalledWith("reply_pr_thread", { repoPath: "/repo", threadId: live.id, body: "Done" });
		expect((current().querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
	});

	// Catches: pending comments not reaching the submit call, or sent without the pinned head.
	it("collects a line comment and submits it pinned to the head the diff was opened at", async () => {
		respond({ submit_pr_draft_review: () => ({ id: 1, url: "u", state: "COMMENTED" }) });
		const { container, findByText, getByLabelText } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findByText("Resolve");
		const widget = container.querySelector('[data-testid="widget"]') as HTMLElement;
		fireEvent.input(widget.querySelector("textarea") as Element, { target: { value: "Rename this" } });
		fireEvent.click(
			Array.from(widget.querySelectorAll("button")).find((b) => b.textContent === "Add to review") as Element,
		);
		await findByText("Pending comment", { selector: "span" });
		fireEvent.click(
			Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Submit review") as Element,
		);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("submit_pr_draft_review", {
				repoPath: "/repo",
				prNumber: 340803,
				draft: {
					headSha,
					body: "",
					event: "COMMENT",
					comments: expect.arrayContaining([expect.objectContaining({ line: 2, side: "RIGHT", body: "Rename this" })]),
				},
			}),
		);
		expect(getByLabelText("Review type")).toBeTruthy();
	});

	// Catches: REQUEST_CHANGES without a body reaching GitHub (HTTP 422).
	it("blocks Request changes until the review has a summary", async () => {
		const { container, findByText, getByLabelText } = render(() => (
			<PrDiffTab prNumber={340803} prTitle="t" diff={DIFF} repoPath="/repo" />
		));
		await findByText("Resolve");
		fireEvent.change(getByLabelText("Review type"), { target: { value: "REQUEST_CHANGES" } });
		const submit = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === "Submit review",
		) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.input(getByLabelText("Review summary"), { target: { value: "Needs work" } });
		expect(submit.disabled).toBe(false);
	});

	// Catches: the review UI shown (and failing) on a tab with no checkout to resolve the account from.
	it("shows no review controls without a repository path", () => {
		const { queryByLabelText } = render(() => <PrDiffTab prNumber={1} prTitle="t" diff={DIFF} />);
		expect(queryByLabelText("Review type")).toBeNull();
		expect(mockInvoke).not.toHaveBeenCalledWith("get_pr_line_threads", expect.anything());
	});
});
