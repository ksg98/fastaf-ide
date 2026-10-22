import { describe, expect, it } from "vitest";
import { isStale, normalizeGitDate, parseGitDate, shortAge } from "../../components/GitPanel/BranchesTab";

// Bug 2: `get_branches_detail` sends `%(committerdate:iso8601)` — "2026-10-21
// 17:46:46 -0700" — which JavaScriptCore (the app's WKWebView) parses as Invalid
// Date, so no branch ever showed an age and stale branches never dimmed. V8 (and
// so this test runner) happens to accept the raw form, which is why the bug never
// showed in tests: assert on the normalised string itself, then on the instant.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("normalizeGitDate", () => {
	it("rewrites git's iso8601 into strict ISO 8601 with a colon offset", () => {
		expect(normalizeGitDate("2026-10-21 17:46:46 -0700")).toBe("2026-10-21T17:46:46-07:00");
	});

	it("handles positive and half-hour offsets", () => {
		expect(normalizeGitDate("2026-01-02 03:04:05 +0530")).toBe("2026-01-02T03:04:05+05:30");
		expect(normalizeGitDate("2026-01-02 03:04:05 +0000")).toBe("2026-01-02T03:04:05+00:00");
	});

	it("trims stray whitespace around the value", () => {
		expect(normalizeGitDate("  2026-10-21 17:46:46 -0700\n")).toBe("2026-10-21T17:46:46-07:00");
	});

	it("passes strict ISO strings and anything else through unchanged", () => {
		expect(normalizeGitDate("2026-10-21T17:46:46-07:00")).toBe("2026-10-21T17:46:46-07:00");
		expect(normalizeGitDate("2026-06-05")).toBe("2026-06-05");
		expect(normalizeGitDate("yesterday")).toBe("yesterday");
	});
});

describe("parseGitDate", () => {
	it("reads git's format as the right instant", () => {
		expect(parseGitDate("2026-10-21 17:46:46 -0700")).toBe(Date.parse("2026-10-22T00:46:46Z"));
		expect(parseGitDate("2026-01-02 03:04:05 +0530")).toBe(Date.parse("2026-01-01T21:34:05Z"));
	});

	it("returns null for a missing or unparseable date", () => {
		expect(parseGitDate(null)).toBeNull();
		expect(parseGitDate(undefined)).toBeNull();
		expect(parseGitDate("")).toBeNull();
		expect(parseGitDate("not a date")).toBeNull();
	});
});

describe("shortAge", () => {
	const now = Date.parse("2026-10-21T18:10:00-07:00");
	const ago = (ms: number) => shortAge(now - ms, now);

	it("uses one short unit per range", () => {
		expect(ago(20 * 1000)).toBe("now");
		expect(ago(25 * MIN)).toBe("25m");
		expect(ago(3 * HOUR)).toBe("3h");
		expect(ago(2 * DAY)).toBe("2d");
		expect(ago(3 * 7 * DAY)).toBe("3w");
		expect(ago(4 * 30 * DAY)).toBe("4mo");
		expect(ago(400 * DAY)).toBe("1y");
	});

	it("switches unit exactly at each boundary", () => {
		expect(ago(59 * MIN)).toBe("59m");
		expect(ago(60 * MIN)).toBe("1h");
		expect(ago(23 * HOUR)).toBe("23h");
		expect(ago(DAY)).toBe("1d");
		expect(ago(6 * DAY)).toBe("6d");
		expect(ago(7 * DAY)).toBe("1w");
		expect(ago(34 * DAY)).toBe("4w");
		expect(ago(35 * DAY)).toBe("1mo");
		expect(ago(364 * DAY)).toBe("12mo");
		expect(ago(365 * DAY)).toBe("1y");
	});

	it("never goes negative for a commit dated in the future (clock skew)", () => {
		expect(shortAge(now + 5 * MIN, now)).toBe("now");
	});

	it("renders the age of a real git date end to end", () => {
		const when = parseGitDate("2026-10-21 17:45:00 -0700");
		expect(when).not.toBeNull();
		expect(shortAge(when as number, now)).toBe("25m");
	});
});

describe("isStale", () => {
	const now = Date.parse("2026-10-21T18:10:00-07:00");

	it("dims branches whose last commit is more than 30 days old", () => {
		expect(isStale(now - 31 * DAY, now)).toBe(true);
		expect(isStale(now - 30 * DAY - 1, now)).toBe(true);
	});

	it("keeps recent branches and unknown dates bright", () => {
		expect(isStale(now - 30 * DAY, now)).toBe(false);
		expect(isStale(now - 2 * DAY, now)).toBe(false);
		expect(isStale(null, now)).toBe(false);
	});

	it("works on git's raw date once parsed", () => {
		expect(isStale(parseGitDate("2026-09-04 10:00:00 -0700"), now)).toBe(true);
		expect(isStale(parseGitDate("2026-10-19 10:00:00 -0700"), now)).toBe(false);
	});
});
