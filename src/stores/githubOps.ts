/**
 * GitHub Ops dashboard store.
 *
 * Accumulates per-repo state from the backend's SSE/window ops events so the
 * GitHub Ops dashboard can render review progress, conflict-assist progress and
 * improvement proposals without polling. CI/merge readiness and live auto-fix
 * sessions are NOT tracked here — the dashboard reads those from `githubStore`
 * and `terminalsStore` respectively.
 *
 * Restored on ego by #795-320b, with two deliberate differences from the
 * version #784-0aec deleted:
 *
 * - `ReviewState` has no `phase`, `llm_used` or `llm_model`. A review is now one
 *   unattended ego turn, so there is no per-file phase to report, and which
 *   model ran is ego's configuration — this side is never told it. Fields that
 *   could only ever be `null` are worse than absent.
 * - `changelog-done` is gone rather than restored. Nothing rendered
 *   `lastChangelogAt` even before the deletion, and the modal awaits its own
 *   command, so the event had no reader.
 *
 * The store subscribes to the ops events on creation. `handleEvent` is exported
 * so tests can drive state transitions without emitting real events.
 */

import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";
import { getRepoConnection } from "../transportRuntime";
import type { CreatedIssue, ImprovementFocus, ImprovementProposal, ImprovementScanResult } from "../types";
import { type RemoteEventPayload, remoteEventOrigin } from "../utils/remoteEventOrigin";
import { appLogger } from "./appLogger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Accumulated review state for a single PR (from `review-progress`). */
export interface ReviewState {
	pr_number: number;
	/** Findings that passed the backend's confidence gate. */
	findingsCount: number;
	done: boolean;
	/** Why the review ended without findings, when that is why. */
	error: string | null;
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
	improvementScanRunning: boolean;
	improvementScanError: string | null;
}

/** The ops events dual-emitted by the backend. */
export const OPS_EVENTS = ["review-progress", "conflict-assist-status", "autofix-status", "proposals-ready"] as const;

export type OpsEvent = (typeof OPS_EVENTS)[number];

/** Envelope shape delivered by both desktop window events and browser SSE. */
export interface OpsEventEnvelope extends RemoteEventPayload {
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
		improvementScanRunning: false,
		improvementScanError: null,
	};
}

/**
 * Read one proposal off the wire, or reject it.
 *
 * The three fields checked are the three the dashboard cannot do without: a
 * title to show, and the issue title and body the "create issue" button would
 * otherwise file empty.
 */
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

/**
 * The PR number an event is about, or `null` when it does not carry one.
 *
 * `Number()` is not the check to use here: it reads `null`, `""` and `[]` as
 * `0`, which is a valid key, so an event missing the field would land as a card
 * for PR #0 instead of being dropped.
 */
function prNumberFromPayload(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
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
		// Paths may coincide across machines: only the registered owner may
		// update this repository's dashboard, on either transport.
		const origin = remoteEventOrigin(data);
		if (data.__tuic_origin !== undefined && !origin) return;
		if (getRepoConnection(repoPath) !== origin?.connection) return;
		const payload = (data.payload ?? {}) as Record<string, unknown>;
		ensureRepo(repoPath);

		switch (eventName) {
			case "review-progress": {
				const prNumber = prNumberFromPayload(payload.pr_number);
				if (prNumber === null) return;
				const count = Number(payload.findings_count);
				setState("repos", repoPath, "reviews", prNumber, {
					pr_number: prNumber,
					findingsCount: Number.isFinite(count) ? count : 0,
					done: payload.done === true,
					error: typeof payload.error === "string" ? payload.error : null,
				});
				break;
			}
			case "conflict-assist-status": {
				const prNumber = prNumberFromPayload(payload.pr_number);
				if (prNumber === null) return;
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
				// The proposals are NOT written here. The backend emits
				// `proposals-ready` with the same payload just before it returns, and
				// that path is the one that has to exist: it reaches every window and
				// every transport, while this return value reaches only the caller.
				// Writing both put the same five proposals into the same slot twice
				// per scan. The result is still returned — callers read it directly.
				return await invoke<ImprovementScanResult>("run_improvement_scan", { repoPath, focus });
			} catch (err) {
				// ego's own sentence, kept verbatim: "no ego executable is
				// configured" is actionable and "scan failed" is not.
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
