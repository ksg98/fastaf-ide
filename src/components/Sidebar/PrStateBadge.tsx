import type { Component } from "solid-js";
import { cx } from "../../utils";
import s from "./Sidebar.module.css";

const PR_BADGE_CLASSES: Record<string, string> = {
	ready: s.prReady,
	open: s.prOpen,
	merged: s.prMerged,
	closed: s.prClosed,
	draft: s.prDraft,
	conflict: s.prConflict,
	"ci-failed": s.prCiFailed,
	"changes-requested": s.prChangesRequested,
	"review-required": s.prReviewRequired,
	"ci-pending": s.prCiPending,
};

/** PR state badge — single badge replacing both old PR number badge and CI ring. */
export const PrStateBadge: Component<{
	prNumber: number;
	state?: string;
	isDraft?: boolean;
	mergeable?: string;
	reviewDecision?: string;
	ciPassed?: number;
	ciFailed?: number;
	ciPending?: number;
}> = (props) => {
	const badge = (): { label: string; cls: string } => {
		if (props.isDraft) return { label: "Draft", cls: "draft" };
		const state = props.state?.toLowerCase();
		if (state === "merged") return { label: "Merged", cls: "merged" };
		if (state === "closed") return { label: "Closed", cls: "closed" };
		if (props.mergeable === "CONFLICTING") return { label: "Conflicts", cls: "conflict" };
		if ((props.ciFailed ?? 0) > 0) return { label: "CI Failed", cls: "ci-failed" };
		if (props.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes Req.", cls: "changes-requested" };
		if (props.reviewDecision === "REVIEW_REQUIRED") return { label: "Review Req.", cls: "review-required" };
		if ((props.ciPending ?? 0) > 0) return { label: "CI Running", cls: "ci-pending" };
		if (props.mergeable === "MERGEABLE" && props.reviewDecision === "APPROVED") {
			return { label: "Ready", cls: "ready" };
		}
		return { label: `#${props.prNumber}`, cls: "open" };
	};

	return (
		<span class={cx(s.prBadge, PR_BADGE_CLASSES[badge().cls])} title={`PR #${props.prNumber}`}>
			{badge().label}
		</span>
	);
};
