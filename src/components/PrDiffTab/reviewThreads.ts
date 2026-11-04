/** Line-review model for the PR Files tab. Mirrors `github_review_threads.rs` payloads. */

import type { WorkItemReviewFinding, WorkItemReviewSeverity } from "../../types/work-items.gen";

export interface ReviewComment {
	id: string;
	databaseId?: number | null;
	body: string;
	url?: string | null;
	/** `bot` is set by the backend from the forge actor type, never from the login. */
	author: { login: string; bot: boolean } | null;
	createdAt: string;
}

export interface ReviewThread {
	id: string;
	path: string;
	line: number | null;
	originalLine: number | null;
	diffSide: "LEFT" | "RIGHT";
	isResolved: boolean;
	isOutdated: boolean;
	comments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ReviewComment[] };
	/** Parsed by the backend from the first comment; untrusted text, shown as text. */
	finding: WorkItemReviewFinding | null;
}

export interface ReviewThreadsPage {
	headSha: string;
	threads: ReviewThread[];
	hasNextPage: boolean;
	endCursor: string | null;
}

export interface DraftComment {
	key: string;
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	body: string;
}

/** What one diff line carries: live threads and the reviewer's own pending comments. */
export interface LineAnnotation {
	threads: ReviewThread[];
	drafts: DraftComment[];
}

export type AnnotationSide = "oldFile" | "newFile";
export type FileAnnotations = Partial<Record<AnnotationSide, Record<string, { data: LineAnnotation }>>>;

export interface FileReview {
	/** Keyed by line number, per side, in the shape `@git-diff-view` expects. */
	lines: FileAnnotations;
	/** Threads whose line no longer exists in the current diff. Never attached to a line. */
	outdated: ReviewThread[];
}

const SEVERITY_RANK: Record<WorkItemReviewSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const rank = (thread: ReviewThread) => (thread.finding?.severity ? SEVERITY_RANK[thread.finding.severity] : 5);
/** Most severe first; unrated threads keep their GitHub order after them. */
const bySeverity = (a: ReviewThread, b: ReviewThread) => rank(a) - rank(b);

const sideKey = (side: "LEFT" | "RIGHT"): AnnotationSide => (side === "LEFT" ? "oldFile" : "newFile");

/** Group threads and drafts per file. An outdated thread is listed apart: GitHub reports `line: null` for it. */
export function groupByFile(threads: ReviewThread[], drafts: DraftComment[]): Map<string, FileReview> {
	const files = new Map<string, FileReview>();
	const fileOf = (path: string) => {
		let review = files.get(path);
		if (!review) {
			review = { lines: {}, outdated: [] };
			files.set(path, review);
		}
		return review;
	};
	const annotation = (review: FileReview, side: "LEFT" | "RIGHT", line: number) => {
		const lines = (review.lines[sideKey(side)] ??= {});
		return (lines[String(line)] ??= { data: { threads: [], drafts: [] } }).data;
	};
	for (const thread of threads.toSorted(bySeverity)) {
		const review = fileOf(thread.path);
		if (thread.isOutdated || thread.line === null) review.outdated.push(thread);
		else annotation(review, thread.diffSide, thread.line).threads.push(thread);
	}
	for (const draft of drafts) annotation(fileOf(draft.path), draft.side, draft.line).drafts.push(draft);
	return files;
}
