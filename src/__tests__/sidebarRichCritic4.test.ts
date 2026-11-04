import { describe, expect, it } from "vitest";
import { agentFacts, type BranchFactsInput, branchFacts, compactAge } from "../utils/sidebarRich";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const base: BranchFactsInput = {
	lastCommitTs: null,
	additions: 0,
	deletions: 0,
	dirtyFiles: null,
	isMerged: false,
};
const agent = { awaitingInput: null, busy: false, agentIntent: null, currentTask: null, lastPrompt: null };

describe("critic round 4: sidebarRich", () => {
	// Catches: a long-lived main/develop branch whose last commit is 40 days old gets a "Stale" chip,
	// which suggests it can be cleaned up; the row is the main checkout.
	it("never calls a main branch stale", () => {
		const input = { ...base, lastCommitTs: NOW - 40 * DAY, isMain: true } as BranchFactsInput;
		expect(branchFacts(input, NOW).state).toBeNull();
	});

	// Catches: an empty-string agentIntent ("" is not nullish) hides the current task and the last prompt.
	it("falls through an empty intent to the task", () => {
		expect(agentFacts({ ...agent, agentIntent: "" }, "Run tests").line).toBe("Run tests");
		expect(agentFacts({ ...agent, agentIntent: "", currentTask: "" }, "").line).toBeNull();
	});

	// Catches: a blank task and blank prompt rendering an empty detail span instead of no line.
	it("returns no line when every source is blank", () => {
		expect(agentFacts({ ...agent, lastPrompt: "" }, null).line).toBeNull();
	});

	// Catches: off-by-one at the 30 day staleness edge and a merged branch also reading stale.
	it("is stale strictly after 30 days, never when merged", () => {
		const at = (ageMs: number, extra = {}) => branchFacts({ ...base, lastCommitTs: NOW - ageMs, ...extra }, NOW).state;
		expect(at(30 * DAY)).toBeNull();
		expect(at(30 * DAY + 1000)).toBe("stale");
		expect(at(90 * DAY, { isMerged: true })).toBe("merged");
		expect(at(90 * DAY, { commitStatus: "merged" })).toBe("merged");
	});

	// Catches: lastCommitTs 0 (no commit data) printed as a 50-year age, and a null dirty count as NaN.
	it("prints nothing for missing data", () => {
		const f = branchFacts({ ...base, lastCommitTs: 0 }, NOW);
		expect(f.commitAge).toBeNull();
		expect(f.state).toBeNull();
		expect(f.sync).toBeNull();
		expect(f.dirtyFiles).toBe(0);
	});

	// Catches: wrong unit step at the minute/hour/day boundaries, and a future timestamp (clock skew) going negative.
	it("formats compact ages at the boundaries", () => {
		expect(compactAge(NOW - 59_999, NOW)).toBe("<1m");
		expect(compactAge(NOW - 60_000, NOW)).toBe("1m");
		expect(compactAge(NOW - 59 * 60_000, NOW)).toBe("59m");
		expect(compactAge(NOW - 60 * 60_000, NOW)).toBe("1h");
		expect(compactAge(NOW - 24 * 3_600_000, NOW)).toBe("1d");
		expect(compactAge(NOW + 5 * 60_000, NOW)).toBe("<1m");
		expect(compactAge(0, NOW)).toBe("");
		expect(compactAge(null, NOW)).toBe("");
	});
});
