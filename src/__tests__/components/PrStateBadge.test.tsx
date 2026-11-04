import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { PrStateBadge } from "../../components/Sidebar/PrStateBadge";

/**
 * The badge must never decide "conflicts" for itself (#8537). GitHub keeps
 * serving the last known `mergeable` while it recomputes after a push, so the
 * only trustworthy answer is the backend's `conflict_state`, which is the same
 * value the PR popover renders.
 */
describe("PrStateBadge conflict rendering", () => {
	const label = (props: Parameters<typeof PrStateBadge>[0]) =>
		render(() => <PrStateBadge {...props} />).container.textContent;

	it("shows Conflicts only when the backend says conflicting", () => {
		expect(label({ prNumber: 1, state: "open", conflictState: "conflicting" })).toBe("#1 Conflicts");
	});

	it("shows a neutral checking state while GitHub recomputes", () => {
		expect(label({ prNumber: 2, state: "open", conflictState: "checking" })).toBe("#2 Checking");
	});

	it("ignores a stale CONFLICTING mergeable while recomputing", () => {
		// The exact regression: mergeable is the pre-push value, already invalidated.
		expect(label({ prNumber: 3, state: "open", mergeable: "CONFLICTING", conflictState: "checking" })).toBe(
			"#3 Checking",
		);
	});

	it("does not invent a conflict from mergeable alone", () => {
		// No conflict_state at all (older payload) must degrade to the plain badge,
		// never to a red accusation.
		expect(label({ prNumber: 4, state: "open", mergeable: "CONFLICTING" })).toBe("#4");
	});

	it("still reports the other states in priority order", () => {
		expect(label({ prNumber: 5, state: "open", isDraft: true, conflictState: "conflicting" })).toBe("#5 Draft");
		expect(label({ prNumber: 6, state: "merged", conflictState: "conflicting" })).toBe("#6 Merged");
		expect(label({ prNumber: 7, state: "open", conflictState: "clear", ciFailed: 1 })).toBe("#7 CI Failed");
		expect(
			label({ prNumber: 8, state: "open", conflictState: "clear", mergeable: "MERGEABLE", reviewDecision: "APPROVED" }),
		).toBe("#8 Ready");
	});
});

describe("PrStateBadge unresolved threads", () => {
	it("shows Comments instead of Ready when an approved PR has unresolved threads", () => {
		const text = render(() => (
			<PrStateBadge
				prNumber={9}
				state="open"
				conflictState="clear"
				mergeable="MERGEABLE"
				reviewDecision="APPROVED"
				unresolvedThreads={3}
			/>
		)).container.textContent;
		expect(text).toBe("#9 Comments");
	});
});

/**
 * The branch-row form drops the pill and the state word to save width, so the
 * state must survive somewhere a reader can reach it: the tooltip, which has to
 * be `data-tooltip` because WKWebView never renders a native `title`.
 */
describe("PrStateBadge compact form", () => {
	const renderCompact = (props: Parameters<typeof PrStateBadge>[0]) =>
		render(() => <PrStateBadge compact {...props} />).container.querySelector(".prBadge") as HTMLElement;

	it("shows only the number and moves the state into the tooltip", () => {
		const badge = renderCompact({ prNumber: 256, state: "open", reviewDecision: "REVIEW_REQUIRED" });
		expect(badge.textContent).toBe("#256");
		expect(badge.getAttribute("data-tooltip")).toBe("PR #256 · Review");
		expect(badge.getAttribute("aria-label")).toBe("PR #256 · Review");
		expect(badge.getAttribute("title")).toBeNull();
	});

	it("keeps the uncommitted-file warning in the tooltip", () => {
		const badge = renderCompact({ prNumber: 12, state: "open", dirtyFiles: 3 });
		expect(badge.getAttribute("data-tooltip")).toBe("PR #12 — 3 uncommitted files");
	});

	it("tells review-required apart from changes-requested, as the pill did", () => {
		const review = renderCompact({ prNumber: 1, state: "open", reviewDecision: "REVIEW_REQUIRED" });
		const changes = renderCompact({ prNumber: 2, state: "open", reviewDecision: "CHANGES_REQUESTED" });
		expect(review.classList.contains("prMarkReview")).toBe(true);
		expect(changes.classList.contains("prMarkChanges")).toBe(true);
		expect(changes.classList.contains("prMarkReview")).toBe(false);
	});

	it("marks a conflict with its own shape, not only its color", () => {
		const badge = renderCompact({ prNumber: 1078, state: "open", conflictState: "conflicting" });
		expect(badge.classList.contains("prMarkConflict")).toBe(true);
		expect(badge.getAttribute("data-tooltip")).toBe("PR #1078 · Conflicts");
	});
});
