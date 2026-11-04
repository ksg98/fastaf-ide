import type { BranchPrStatus } from "../types";

/** What the readiness verdict needs from a PR. Every surface (sidebar badge,
 *  PR panel, Ops dashboard) feeds this one shape so they cannot disagree. */
export interface PrReadinessInput {
	state?: string;
	isDraft?: boolean;
	/** Backend verdict (`classify_conflict_state`). Never derive a conflict from `mergeable`:
	 *  GitHub keeps serving the last value while it recomputes (#8537). */
	conflictState?: string;
	mergeable?: string;
	reviewDecision?: string;
	ciFailed?: number;
	ciPending?: number;
	unresolvedThreads?: number;
	/** The thread count covers only the first page: 0 is then "unknown", never "none". */
	unresolvedThreadsTruncated?: boolean;
}

export type PrReadinessKind =
	| "draft"
	| "merged"
	| "closed"
	| "conflict"
	| "checking"
	| "ci-failed"
	| "changes-requested"
	| "unresolved-comments"
	| "review-required"
	| "ci-pending"
	| "ready"
	| "open";

export type PrReadinessSeverity = "ok" | "warn" | "critical" | "muted";

/** Highest-priority blocker first. Red CI and requested changes outrank unresolved
 *  threads; unresolved threads outrank "awaiting review" because someone already
 *  reviewed and left work behind. */
export function prReadiness(pr: PrReadinessInput): PrReadinessKind {
	if (pr.isDraft) return "draft";
	const state = pr.state?.toLowerCase();
	if (state === "merged") return "merged";
	if (state === "closed") return "closed";
	if (pr.conflictState === "conflicting") return "conflict";
	if (pr.conflictState === "checking") return "checking";
	if ((pr.ciFailed ?? 0) > 0) return "ci-failed";
	if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
	if ((pr.unresolvedThreads ?? 0) > 0 || pr.unresolvedThreadsTruncated) return "unresolved-comments";
	if (pr.reviewDecision === "REVIEW_REQUIRED") return "review-required";
	if ((pr.ciPending ?? 0) > 0) return "ci-pending";
	if (pr.mergeable === "MERGEABLE" && pr.reviewDecision === "APPROVED") return "ready";
	return "open";
}

export const PR_READINESS_LABELS: Record<PrReadinessKind, string> = {
	draft: "Draft",
	merged: "Merged",
	closed: "Closed",
	conflict: "Conflicts",
	checking: "Checking",
	"ci-failed": "CI Failed",
	"changes-requested": "Changes Req.",
	"unresolved-comments": "Comments",
	"review-required": "Review",
	"ci-pending": "CI Running",
	ready: "Ready",
	open: "Open",
};

export const PR_READINESS_SEVERITY: Record<PrReadinessKind, PrReadinessSeverity> = {
	draft: "muted",
	merged: "muted",
	closed: "muted",
	conflict: "critical",
	checking: "warn",
	"ci-failed": "critical",
	"changes-requested": "critical",
	"unresolved-comments": "warn",
	"review-required": "warn",
	"ci-pending": "warn",
	ready: "ok",
	open: "muted",
};

/** Adapter for the batch payload, shared by the panel and the Ops dashboard. */
export function prReadinessOf(pr: BranchPrStatus): PrReadinessKind {
	return prReadiness({
		state: pr.state,
		isDraft: pr.is_draft,
		conflictState: pr.conflict_state,
		mergeable: pr.mergeable,
		reviewDecision: pr.review_decision,
		ciFailed: pr.checks?.failed,
		ciPending: pr.checks?.pending,
		unresolvedThreads: pr.unresolved_threads,
		unresolvedThreadsTruncated: pr.unresolved_threads_truncated,
	});
}
