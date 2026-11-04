import { type Accessor, createSignal } from "solid-js";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import type { DraftComment, ReviewComment, ReviewThread, ReviewThreadsPage } from "./reviewThreads";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface CommentsPage {
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: ReviewComment[];
}

export interface ReviewSession {
	threads: Accessor<ReviewThread[]>;
	drafts: Accessor<DraftComment[]>;
	/** Head the diff was opened at. Drafts are pinned to it. */
	headSha: Accessor<string | null>;
	/** The PR moved after the diff was opened: drafts can no longer be submitted. */
	headMoved: Accessor<boolean>;
	loading: Accessor<boolean>;
	error: Accessor<string | null>;
	busyThread: Accessor<string | null>;
	submitting: Accessor<boolean>;
	refresh(): Promise<void>;
	/** The diff was reopened at another head: drop threads, drafts and the move flag, then re-read. */
	reset(pin?: string): Promise<void>;
	reply(threadId: string, body: string): Promise<boolean>;
	setResolved(threadId: string, resolved: boolean): Promise<void>;
	loadMoreComments(threadId: string): Promise<void>;
	addDraft(draft: Omit<DraftComment, "key">): void;
	removeDraft(key: string): void;
	submit(body: string, event: ReviewEvent): Promise<boolean>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Thread, reply, resolve and draft-review state for one PR. Mutations change the UI only after the backend confirms.
 * `pin` is the head the diff was fetched at. Without it the first thread read pins the head and reports it to `onPin`.
 */
export function createReviewSession(
	repoPath: string,
	prNumber: number,
	pin?: string,
	onPin?: (headSha: string) => void,
): ReviewSession {
	const [threads, setThreads] = createSignal<ReviewThread[]>([]);
	const [drafts, setDrafts] = createSignal<DraftComment[]>([]);
	const [headSha, setHeadSha] = createSignal<string | null>(pin ?? null);
	const [headMoved, setHeadMoved] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [busyThread, setBusyThread] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	let nextDraft = 0;
	let generation = 0;

	const replaceThread = (id: string, update: (t: ReviewThread) => ReviewThread) =>
		setThreads((all) => all.map((t) => (t.id === id ? update(t) : t)));

	async function refresh() {
		const started = generation;
		setLoading(true);
		setError(null);
		try {
			const all: ReviewThread[] = [];
			let after: string | null = null;
			let head = "";
			do {
				const page: ReviewThreadsPage = await invoke<ReviewThreadsPage>("get_pr_line_threads", {
					repoPath,
					prNumber,
					after,
				});
				head = page.headSha;
				all.push(...page.threads);
				after = page.hasNextPage ? page.endCursor : null;
			} while (after);
			if (started !== generation) return; // reset() superseded this read
			setThreads(all);
			if (headSha() === null) {
				setHeadSha(head);
				onPin?.(head);
			} else if (headSha() !== head) setHeadMoved(true);
		} catch (e) {
			if (started !== generation) return;
			appLogger.warn("github", "Failed to load review threads", { error: message(e) });
			setError(message(e));
		} finally {
			if (started === generation) setLoading(false);
		}
	}

	async function reset(next?: string) {
		generation++;
		setThreads([]);
		setDrafts([]);
		setHeadSha(next ?? null);
		setHeadMoved(false);
		setError(null);
		await refresh();
	}

	/** Run a thread mutation; `busyThread` and `error` describe the outcome. */
	async function mutate<T>(threadId: string, run: () => Promise<T>): Promise<T | undefined> {
		setBusyThread(threadId);
		setError(null);
		try {
			return await run();
		} catch (e) {
			setError(message(e));
			return undefined;
		} finally {
			setBusyThread(null);
		}
	}

	return {
		threads,
		drafts,
		headSha,
		headMoved,
		loading,
		error,
		busyThread,
		submitting,
		refresh,
		reset,
		async reply(threadId, body) {
			const comment = await mutate(threadId, () =>
				invoke<ReviewComment>("reply_pr_thread", { repoPath, threadId, body }),
			);
			if (!comment) return false;
			replaceThread(threadId, (t) => ({ ...t, comments: { ...t.comments, nodes: [...t.comments.nodes, comment] } }));
			return true;
		},
		async setResolved(threadId, resolved) {
			const confirmed = await mutate(threadId, () =>
				invoke<ReviewThread>("set_pr_thread_resolved", { repoPath, threadId, resolved }),
			);
			if (confirmed) replaceThread(threadId, () => confirmed);
		},
		async loadMoreComments(threadId) {
			const thread = threads().find((t) => t.id === threadId);
			if (!thread?.comments.pageInfo.hasNextPage) return;
			const page = await mutate(threadId, () =>
				invoke<CommentsPage>("get_pr_thread_comments", {
					repoPath,
					threadId,
					after: thread.comments.pageInfo.endCursor,
				}),
			);
			if (page)
				replaceThread(threadId, (t) => ({
					...t,
					comments: { pageInfo: page.pageInfo, nodes: [...t.comments.nodes, ...page.nodes] },
				}));
		},
		addDraft(draft) {
			if (headMoved()) return;
			setDrafts((all) => [...all, { ...draft, key: `draft-${++nextDraft}` }]);
		},
		removeDraft(key) {
			setDrafts((all) => all.filter((d) => d.key !== key));
		},
		async submit(body, event) {
			const head = headSha();
			if (!head || submitting()) return false;
			setSubmitting(true);
			setError(null);
			try {
				await invoke("submit_pr_draft_review", {
					repoPath,
					prNumber,
					draft: {
						headSha: head,
						body,
						event,
						comments: drafts().map(({ path, line, side, body: text }) => ({ path, line, side, body: text })),
					},
				});
			} catch (e) {
				const text = message(e);
				// The backend refuses a stale head: keep the drafts, tell the reviewer to reopen the diff.
				if (text.includes("review-head-changed")) setHeadMoved(true);
				setError(text);
				return false;
			} finally {
				setSubmitting(false);
			}
			setDrafts([]);
			await refresh();
			return true;
		},
	};
}
