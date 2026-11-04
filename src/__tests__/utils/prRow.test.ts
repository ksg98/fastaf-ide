import { describe, expect, it } from "vitest";
import type { BranchPrStatus } from "../../types";
import { canUpdatePrBranch, prAgeMarker, prReference } from "../../utils/prRow";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("prAgeMarker", () => {
	it.each([
		[13, null],
		[14, "2w"],
		[29, "2w"],
		[30, "1m"],
		[90, "3m"],
		[180, "6m"],
		[400, "6m"],
	])("%i days old -> %s", (days, marker) => {
		expect(prAgeMarker(daysAgo(days), NOW)).toBe(marker);
	});

	it("returns null for an unparsable date instead of a bogus marker", () => {
		expect(prAgeMarker("", NOW)).toBeNull();
	});
});

describe("prReference", () => {
	it("builds owner/repo#N from the PR url, not the url or bare number", () => {
		// Catches: copying the URL or only the number.
		expect(prReference({ url: "https://github.com/acme/api/pull/12", number: 12 })).toBe("acme/api#12");
	});

	it("works for GitHub Enterprise hosts and rejects non-PR urls", () => {
		expect(prReference({ url: "https://ghe.corp.example/org/repo/pull/7", number: 7 })).toBe("org/repo#7");
		expect(prReference({ url: "", number: 7 })).toBeNull();
		expect(prReference({ url: "https://github.com/acme/api/issues/7", number: 7 })).toBeNull();
	});
});

describe("canUpdatePrBranch", () => {
	const pr = (o: Partial<BranchPrStatus>) =>
		({ state: "OPEN", merge_state_status: "BEHIND", head_ref_oid: "abc", ...o }) as BranchPrStatus;

	it("is offered only for an open BEHIND PR with a known head", () => {
		expect(canUpdatePrBranch(pr({}))).toBe(true);
		expect(canUpdatePrBranch(pr({ merge_state_status: "CLEAN" }))).toBe(false);
		expect(canUpdatePrBranch(pr({ state: "MERGED" }))).toBe(false);
		// No head to pin to: updating against an unknown head is exactly the bug the pin prevents.
		expect(canUpdatePrBranch(pr({ head_ref_oid: "" }))).toBe(false);
	});
});
