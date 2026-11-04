import { describe, expect, it } from "vitest";
import type { BranchPrStatus } from "../../types";
import { canUpdatePrBranch, prAgeMarker, prReference } from "../../utils/prRow";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

describe("prAgeMarker (critic round 2)", () => {
	// Catches: `>` instead of `>=` at each threshold, or thresholds off by one day.
	it.each([
		[13.99, null],
		[14, "2w"],
		[29.99, "2w"],
		[30, "1m"],
		[89.99, "1m"],
		[90, "3m"],
		[179.99, "3m"],
		[180, "6m"],
		[400, "6m"],
	])("%s days old -> %s", (days, expected) => {
		expect(prAgeMarker(ago(days as number), NOW)).toBe(expected);
	});

	// Catches: NaN/negative ages (clock skew, empty createdAt) producing a marker.
	it.each(["", "not-a-date"])("unparseable createdAt %j gives no marker", (v) => {
		expect(prAgeMarker(v, NOW)).toBeNull();
	});
	it("a createdAt in the future gives no marker", () => {
		expect(prAgeMarker(ago(-5), NOW)).toBeNull();
	});
});

describe("prReference (critic round 2)", () => {
	// Catches: reference built from a URL tail (files/commits view) or an issues URL.
	it("accepts a pull URL with a /files suffix and a trailing slash", () => {
		expect(prReference({ url: "https://github.com/o/r/pull/5/files", number: 5 })).toBe("o/r#5");
		expect(prReference({ url: "https://ghe.corp.example/o/r/pull/9/", number: 9 })).toBe("o/r#9");
	});
	it.each(["", "https://github.com/o/r/issues/5", "https://github.com/o", "garbage"])("%j gives null", (url) => {
		expect(prReference({ url, number: 5 })).toBeNull();
	});
});

describe("canUpdatePrBranch (critic round 2)", () => {
	const pr = (o: Partial<BranchPrStatus>) =>
		({ state: "OPEN", merge_state_status: "BEHIND", head_ref_oid: "abc", ...o }) as BranchPrStatus;
	// Catches: offering a pinned update with no pin, or on merged/draft-less closed PRs.
	it("needs open + BEHIND + a head sha", () => {
		expect(canUpdatePrBranch(pr({}))).toBe(true);
		expect(canUpdatePrBranch(pr({ head_ref_oid: "" }))).toBe(false);
		expect(canUpdatePrBranch(pr({ state: "MERGED" }))).toBe(false);
		expect(canUpdatePrBranch(pr({ merge_state_status: "CLEAN" }))).toBe(false);
		expect(canUpdatePrBranch(pr({ merge_state_status: "behind" as never }))).toBe(false);
	});
});
