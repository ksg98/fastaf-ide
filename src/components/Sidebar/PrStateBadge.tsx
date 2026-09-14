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
	checking: s.prCiPending,
	"ci-failed": s.prCiFailed,
	"changes-requested": s.prChangesRequested,
	"review-required": s.prReviewRequired,
	"ci-pending": s.prCiPending,
};

/** PR state badge — keeps the PR identity visible alongside its highest-priority state. */
export const PrStateBadge: Component<{
	prNumber: number;
	state?: string;
	isDraft?: boolean;
	mergeable?: string;
	/** Backend verdict — the ONE rule (`classify_conflict_state`). Never re-derive
	 *  a conflict from `mergeable` here: GitHub keeps serving the last known value
	 *  while it recomputes, which is how this badge used to accuse a PR of
	 *  conflicting on data GitHub had already invalidated (#8537). */
	conflictState?: string;
	reviewDecision?: string;
	ciPassed?: number;
	ciFailed?: number;
	ciPending?: number;
}> = (props) => {
	const badge = (): { label: string; cls: string } => {
		const withNumber = (state: string) => `#${props.prNumber} ${state}`;
		if (props.isDraft) return { label: withNumber("Draft"), cls: "draft" };
		const state = props.state?.toLowerCase();
		if (state === "merged") return { label: withNumber("Merged"), cls: "merged" };
		if (state === "closed") return { label: withNumber("Closed"), cls: "closed" };
		if (props.conflictState === "conflicting") return { label: withNumber("Conflicts"), cls: "conflict" };
		if (props.conflictState === "checking") return { label: withNumber("Checking"), cls: "checking" };
		if ((props.ciFailed ?? 0) > 0) return { label: withNumber("CI Failed"), cls: "ci-failed" };
		if (props.reviewDecision === "CHANGES_REQUESTED") {
			return { label: withNumber("Changes Req."), cls: "changes-requested" };
		}
		if (props.reviewDecision === "REVIEW_REQUIRED") {
			return { label: withNumber("Review Req."), cls: "review-required" };
		}
		if ((props.ciPending ?? 0) > 0) return { label: withNumber("CI Running"), cls: "ci-pending" };
		if (props.mergeable === "MERGEABLE" && props.reviewDecision === "APPROVED") {
			return { label: withNumber("Ready"), cls: "ready" };
		}
		return { label: `#${props.prNumber}`, cls: "open" };
	};

	return (
		<span class={cx(s.prBadge, PR_BADGE_CLASSES[badge().cls])} title={`PR #${props.prNumber}`}>
			{badge().label}
		</span>
	);
};
