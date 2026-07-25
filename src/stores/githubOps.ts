/**
 * GitHub Ops dashboard store.
 *
 * Accumulates per-repo state from the backend's SSE/window ops events so the
 * GitHub Ops dashboard can render review findings, conflict-assist progress,
 * proposals, and changelog activity without polling. CI/merge readiness and
 * live auto-fix sessions are NOT tracked here — the dashboard reads those from
 * `githubStore` and `terminalsStore` respectively.
 *
 * The store subscribes to the five ops events on creation. `handleEvent` is
 * exported so tests can drive state transitions without emitting real events.
 */

import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";
import type { CreatedIssue, ImprovementFocus, ImprovementProposal, ImprovementScanResult } from "../types";
import { appLogger } from "./appLogger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Accumulated review state for a single PR (from `review-progress`). */
export interface ReviewState {
	pr_number: number;
	/** Number of findings/files reported for the current review pass. */
	findingsCount: number;
	phase: string | null;
	done: boolean;
	llm_used?: boolean;
	llm_model?: string | null;
}

/** Accumulated conflict-assist state for a single PR (from `conflict-assist-status`). */
export interface ConflictState {
	pr_number: number;
	status: string | null;
	conflicted_files: string[];
}

/** Per-repo accumulated ops state. */
export interface RepoOpsState {
	reviews: Record<number, ReviewState>;
	conflicts: Record<number, ConflictState>;
	/** Populated by `proposals-ready` after an improvement scan. */
	proposals: ImprovementProposal[];
	/** Timestamp (ms) of the last `changelog-done` event, or null. */
	lastChangelogAt: number | null;
	improvementScanRunning: boolean;
	improvementScanError: string | null;
}

/** The five ops events dual-emitted by the backend. */
export const OPS_EVENTS = [
	"review-progress",
	"conflict-assist-status",
	"autofix-status",
	"proposals-ready",
	"changelog-done",
] as const;

export type OpsEvent = (typeof OPS_EVENTS)[number];

/** Envelope shape delivered by both desktop window events and browser SSE. */
export interface OpsEventEnvelope {
	repo_path: string;
	payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function emptyRepoState(): RepoOpsState {
	return {
		reviews: {},
		conflicts: {},
		proposals: [],
		lastChangelogAt: null,
		improvementScanRunning: false,
		improvementScanError: null,
	};
}

function proposalFromPayload(value: unknown): ImprovementProposal | null {
	if (!value || typeof value !== "object") return null;
	const p = value as Record<string, unknown>;
	if (typeof p.title !== "string" || typeof p.issue_title !== "string" || typeof p.issue_body !== "string") {
		return null;
	}
	return {
		title: p.title,
		summary: typeof p.summary === "string" ? p.summary : "",
		rationale: typeof p.rationale === "string" ? p.rationale : "",
		issue_title: p.issue_title,
		issue_body: p.issue_body,
		labels: Array.isArray(p.labels) ? p.labels.filter((label): label is string => typeof label === "string") : [],
		impact: typeof p.impact === "string" ? p.impact : "medium",
		effort: typeof p.effort === "string" ? p.effort : "medium",
	};
}

export function createGithubOpsStore() {
	const [state, setState] = createStore<{ repos: Record<string, RepoOpsState> }>({ repos: {} });

	function ensureRepo(repoPath: string): void {
		if (!state.repos[repoPath]) setState("repos", repoPath, emptyRepoState());
	}

	/**
	 * Apply one ops event to the store. `data` is the envelope `{ repo_path, payload }`.
	 * Exported (below) so tests can drive transitions without real events.
	 */
	function handleEvent(eventName: string, data: OpsEventEnvelope): void {
		if (!data || typeof data !== "object") return;
		const repoPath = data.repo_path;
		if (!repoPath) return;
		const payload = (data.payload ?? {}) as Record<string, unknown>;
		ensureRepo(repoPath);

		switch (eventName) {
			case "review-progress": {
				const prNumber = Number(payload.pr_number);
				if (!Number.isFinite(prNumber)) return;
				const files = payload.files;
				const findingsCount = Array.isArray(files) ? files.length : typeof files === "number" ? files : 0;
				setState("repos", repoPath, "reviews", prNumber, {
					pr_number: prNumber,
					findingsCount,
					phase: typeof payload.phase === "string" ? payload.phase : null,
					done: payload.done === true,
					llm_used: payload.llm_used === true,
					llm_model: typeof payload.llm_model === "string" ? payload.llm_model : null,
				});
				break;
			}
			case "conflict-assist-status": {
				const prNumber = Number(payload.pr_number);
				if (!Number.isFinite(prNumber)) return;
				const conflicted = payload.conflicted_files;
				setState("repos", repoPath, "conflicts", prNumber, {
					pr_number: prNumber,
					status: typeof payload.status === "string" ? payload.status : null,
					conflicted_files: Array.isArray(conflicted) ? (conflicted as string[]) : [],
				});
				break;
			}
			case "proposals-ready": {
				const proposals = Array.isArray(payload.proposals)
					? payload.proposals.map(proposalFromPayload).filter((p): p is ImprovementProposal => p !== null)
					: [];
				setState("repos", repoPath, "proposals", proposals);
				setState("repos", repoPath, "improvementScanRunning", false);
				setState("repos", repoPath, "improvementScanError", null);
				break;
			}
			case "changelog-done": {
				setState("repos", repoPath, "lastChangelogAt", Date.now());
				break;
			}
			case "autofix-status": {
				// No producer yet, and the dashboard reads live auto-fix sessions from
				// terminalsStore — nothing to accumulate here.
				break;
			}
			default:
				break;
		}
	}

	// Subscribe to all ops events. Listeners just forward to handleEvent.
	for (const ev of OPS_EVENTS) {
		listen<OpsEventEnvelope>(ev, (event) => handleEvent(ev, event.payload)).catch((err) =>
			appLogger.debug("github", `githubOps listen(${ev}) failed`, err),
		);
	}

	return {
		state,
		handleEvent,
		/** Reactive per-repo state, or a clean default when the repo is unseen. */
		getState(repoPath: string): RepoOpsState {
			return state.repos[repoPath] ?? emptyRepoState();
		},
		async runImprovementScan(repoPath: string, focus: ImprovementFocus): Promise<ImprovementScanResult> {
			ensureRepo(repoPath);
			setState("repos", repoPath, "improvementScanRunning", true);
			setState("repos", repoPath, "improvementScanError", null);
			try {
				const result = await invoke<ImprovementScanResult>("run_improvement_scan", { repoPath, focus });
				setState("repos", repoPath, "proposals", result.proposals);
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setState("repos", repoPath, "improvementScanError", message);
				appLogger.warn("github", "Improvement scan failed", { repoPath, focus, error: message });
				throw err;
			} finally {
				setState("repos", repoPath, "improvementScanRunning", false);
			}
		},
		async createIssueFromProposal(repoPath: string, proposal: ImprovementProposal): Promise<CreatedIssue> {
			return invoke<CreatedIssue>("create_issue_from_proposal", { repoPath, proposal });
		},
	};
}

export const githubOpsStore = createGithubOpsStore();
