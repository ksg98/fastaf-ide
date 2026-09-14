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
