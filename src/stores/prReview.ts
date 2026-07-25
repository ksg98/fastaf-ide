// PR AI-review helpers — pure functions shared by the review UI and tests.
//
// The review engine (Rust `run_pr_review`) already confidence-gates findings
// server-side (see diff_triage.rs `filter_findings_by_confidence`), so the
// frontend never re-filters on confidence — it only flattens the per-file
// results into a flat, selectable list and enforces the GitHub inline-comment
// gate (a finding needs a concrete line to be postable as an inline comment).

import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import type { FileClassification, Finding } from "./aiTriageStore";
import { appLogger } from "./appLogger";

export interface ReviewFinding extends Finding {
	/** Stable identity for selection state: `path:line-or-file:index`. */
	id: string;
	/** The owning file's one-line summary, for context in the list. */
	fileSummary: string;
}

/**
 * Flatten per-file classifications into a single ordered finding list.
 * The id is stable per (path, line, per-file index) so selection survives
 * re-renders and repeated flattens of the same result.
 */
export function flattenReviewFindings(files: FileClassification[]): ReviewFinding[] {
	return files.flatMap((file) =>
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
export function postableFindings(findings: ReviewFinding[], selectedIds: ReadonlySet<string>): ReviewFinding[] {
	return findings.filter((finding) => selectedIds.has(finding.id) && finding.line != null);
}

/** Whether a finding can be selected/posted at all (has a concrete line). */
export function isPostable(finding: Pick<Finding, "line">): boolean {
	return finding.line != null;
}

/** Raw result shape returned by the Rust `run_pr_review` command. */
export interface PrReviewResult {
	summary: string | null;
	files: FileClassification[];
	llm_used: boolean;
	llm_model: string | null;
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
	async function post(repoPath: string, prNumber: number, findings: ReviewFinding[]): Promise<void> {
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
					body: finding.message,
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
