import { describe, expect, it } from "vitest";
import { classifyDiffFile, globToRegExp, parseLinguistGenerated } from "../../utils/diffFileScope";

describe("diffFileScope (critic round 3)", () => {
	// Catches: `!linguist-generated` (attribute reset to unspecified) ignored, so an earlier
	// `*.js linguist-generated` keeps collapsing a file the later line explicitly un-marks.
	it("a later `!linguist-generated` line resets an earlier set", () => {
		const patterns = parseLinguistGenerated("*.gen.ts linguist-generated\nkeep.gen.ts !linguist-generated\n");
		expect(classifyDiffFile("a/x.gen.ts", patterns)).toBe("generated");
		expect(classifyDiffFile("a/keep.gen.ts", patterns)).toBeNull();
	});

	// Catches: CRLF .gitattributes (Windows checkout) leaving `\r` glued to the last token so the
	// attribute is never recognised and nothing collapses.
	it("parses a CRLF .gitattributes", () => {
		const patterns = parseLinguistGenerated("gen/** linguist-generated\r\nother/** linguist-generated=true\r\n");
		expect(classifyDiffFile("gen/a.ts", patterns)).toBe("generated");
		expect(classifyDiffFile("other/a.ts", patterns)).toBe("generated");
	});

	// Catches: gitattributes bracket classes escaped to literals, so `gen[0-9].ts` never matches `gen1.ts`.
	it("supports bracket character classes", () => {
		expect(globToRegExp("gen[0-9].ts").test("gen1.ts")).toBe(true);
		expect(globToRegExp("gen[0-9].ts").test("genx.ts")).toBe(false);
	});

	// Catches: a hand-written source directory named `build`/`dist`/`vendor` anywhere in the path
	// collapsing as "generated" (scripts/build/release.ts is reviewable code).
	it("does not collapse hand-written code under a nested scripts/build directory", () => {
		expect(classifyDiffFile("scripts/build/release.ts")).toBeNull();
	});

	// Catches: `dir/` pattern matching a FILE called `dir` or a sibling prefix like `gen-extra/`.
	it("a trailing-slash pattern matches only that directory's contents", () => {
		const re = globToRegExp("gen/");
		expect(re.test("gen/a/b.ts")).toBe(true);
		expect(re.test("gen-extra/a.ts")).toBe(false);
		expect(re.test("src/gen")).toBe(false);
	});
});
