import { describe, expect, it } from "vitest";
import { prReadiness } from "../../utils/prReadiness";

const approved = { state: "OPEN", conflictState: "clear", mergeable: "MERGEABLE", reviewDecision: "APPROVED" };

describe("prReadiness (critic round 2)", () => {
	// Catches: an approved, mergeable PR with open threads still reading "ready".
	it("unresolved threads block ready even when approved and mergeable", () => {
		expect(prReadiness({ ...approved, unresolvedThreads: 1 })).toBe("unresolved-comments");
	});

	// Catches: threads outranking a failing check (red CI must stay the visible reason).
	it("red CI outranks unresolved threads", () => {
		expect(prReadiness({ ...approved, ciFailed: 1, unresolvedThreads: 3 })).toBe("ci-failed");
	});

	// Catches: a negative/undefined count flipping the verdict.
	it.each([undefined, 0, -1])("threads=%s does not change the verdict", (n) => {
		expect(prReadiness({ ...approved, unresolvedThreads: n })).toBe("ready");
	});

	// Catches: UNKNOWN merge state (backend conflict_state "checking") read as ready/open.
	it("a recomputing merge state shows checking even when approved", () => {
		expect(prReadiness({ ...approved, conflictState: "checking" })).toBe("checking");
	});

	// Catches: terminal PRs showing a blocker from stale thread counts.
	it.each(["MERGED", "CLOSED", "merged"])("%s ignores unresolved threads", (state) => {
		expect(prReadiness({ ...approved, state, unresolvedThreads: 5 })).toBe(state.toLowerCase());
	});
});
