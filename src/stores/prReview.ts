// PR AI-review state and the pure helpers around it.
//
// The confidence gate lives in Rust (`pr_review::filter_findings_by_confidence`,
// applied before the result leaves the backend), so this side never re-filters
// on confidence — a finding that arrives here is a finding worth showing. What
// is left for the frontend is two things the backend cannot decide: a stable
// identity so a selection survives re-renders, and GitHub's rule that an inline
// review comment needs a concrete line.

import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import type { PrReviewResult, ReviewedFile, ReviewFinding } from "../types";
import { appLogger } from "./appLogger";

/** A finding lifted out of its file, with what the list needs to render it. */
export interface SelectableFinding extends ReviewFinding {
	/** Stable identity for selection state: `path:line-or-file:index`. */
	id: string;
	/** The owning file's one-line summary, for context in the list. */
	fileSummary: string;
}

/**
 * Flatten per-file results into a single ordered finding list.
 * The id is stable per (path, line, per-file index) so selection survives
 * re-renders and repeated flattens of the same result.
 */
export function flattenReviewFindings(files: ReviewedFile[]): SelectableFinding[] {
	return files.flatMap((file) =>
		// Tolerate a file reported without a findings array.
		(file.findings ?? []).map((finding, index) => ({
			...finding,
			id: `${finding.path}:${finding.line ?? "file"}:${index}`,
			fileSummary: file.summary,
		})),
	);
}

/**
 * The subset of findings that can be posted to GitHub as inline review
 * comments: selected by the user AND anchored to a concrete line. File-level
 * findings (line == null) are shown but not postable — GitHub's review API
 * requires a line for each `comments[]` entry.
 */
export function postableFindings(findings: SelectableFinding[], selectedIds: ReadonlySet<string>): SelectableFinding[] {
	return findings.filter((finding) => selectedIds.has(finding.id) && finding.line != null);
}

/** Whether a finding can be selected/posted at all (has a concrete line). */
export function isPostable(finding: Pick<ReviewFinding, "line">): boolean {
	return finding.line != null;
}

export type ReviewStatus = "idle" | "running" | "done" | "error";

/** Per-PR review state, keyed by repo+PR so it survives popover close/reopen. */
interface ReviewEntry {
	status: ReviewStatus;
	result: PrReviewResult | null;
	error: string | null;
	/** Ids of findings selected for posting; seeded to all on completion. */
	selectedIds: string[];
	/** True while a post-to-GitHub request is in flight. */
	posting: boolean;
}

interface PrReviewStoreState {
	entries: Record<string, ReviewEntry>;
}

/** Appended to every finding posted for ego, so the thread split counts it as
 *  ego's rather than a human's. Must equal `review_bots::EGO_MARKER` in Rust. */
export const EGO_MARKER = "<!-- tuic:ego-review -->";

const reviewKey = (repoPath: string, prNumber: number): string => `${repoPath}#${prNumber}`;

/**
 * Session-scoped store owning AI-review state per PR. The `run`/`post` actions
 * own their `invoke` calls so an in-flight review survives the popover being
 * closed — the result lands here regardless of component lifecycle, and
 * reopening the popover shows the running/done/error state instead of resetting
 * to "Run" with no record of what happened.
 *
 * In-memory only (no persistence): reviews are cheap to re-run and results go
 * stale against the PR diff, so we intentionally drop them on app restart.
 */
function createPrReviewStore() {
	const [state, setState] = createStore<PrReviewStoreState>({ entries: {} });

	function get(repoPath: string, prNumber: number): ReviewEntry | undefined {
		return state.entries[reviewKey(repoPath, prNumber)];
	}

	async function run(repoPath: string, prNumber: number): Promise<void> {
		const key = reviewKey(repoPath, prNumber);
		if (state.entries[key]?.status === "running") return;
		setState("entries", key, { status: "running", result: null, error: null, selectedIds: [], posting: false });
		try {
			const result = await invoke<PrReviewResult>("run_pr_review", { repoPath, prNumber });
			const selectedIds = flattenReviewFindings(result.files).map((finding) => finding.id);
			setState("entries", key, { status: "done", result, error: null, selectedIds, posting: false });
		} catch (e) {
			// The message is the review engine's own — "no provider is configured",
			// a provider error. Replacing it with a generic one here is exactly the
			// silent-empty-result criterion 5 forbids.
			setState("entries", key, { status: "error", result: null, error: String(e), selectedIds: [], posting: false });
			appLogger.warn("github", "Failed to run PR AI review", { error: String(e) });
		}
	}

	function toggleFinding(repoPath: string, prNumber: number, id: string): void {
		const key = reviewKey(repoPath, prNumber);
		const entry = state.entries[key];
		if (!entry) return;
		const next = entry.selectedIds.includes(id)
			? entry.selectedIds.filter((existing) => existing !== id)
			: [...entry.selectedIds, id];
		setState("entries", key, "selectedIds", next);
	}

	/** Post the given findings to GitHub as inline review comments. */
	async function post(repoPath: string, prNumber: number, findings: SelectableFinding[]): Promise<void> {
		const key = reviewKey(repoPath, prNumber);
		if (findings.length === 0 || state.entries[key]?.posting) return;
		setState("entries", key, "posting", true);
		setState("entries", key, "error", null);
		try {
			await invoke("post_pr_review", {
				repoPath,
				prNumber,
				body: "AI review findings",
				event: "COMMENT",
				comments: findings.map((finding) => ({
					path: finding.path,
					line: finding.line,
					side: "RIGHT",
					body: `${finding.message}\n\n${EGO_MARKER}`,
				})),
			});
		} catch (e) {
			setState("entries", key, "error", String(e));
			appLogger.warn("github", "Failed to post PR review", { error: String(e) });
		} finally {
			setState("entries", key, "posting", false);
		}
	}

	return { state, get, run, toggleFinding, post };
}

export const prReviewStore = createPrReviewStore();
