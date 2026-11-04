import { describe, expect, it } from "vitest";
import { classifyDiffFile, globToRegExp, parseLinguistGenerated } from "../../utils/diffFileScope";

describe("globToRegExp (critic round 2)", () => {
	// Catches: `**/` translated to a bare `.*`, so `**/gen.ts` also matches `xgen.ts`
	// and a hand-written file is collapsed as generated.
	it("`**/name` matches the name at any depth but never a longer basename", () => {
		const re = globToRegExp("**/gen.ts");
		expect(re.test("gen.ts")).toBe(true);
		expect(re.test("a/b/gen.ts")).toBe(true);
		expect(re.test("xgen.ts")).toBe(false);
		expect(re.test("a/xgen.ts")).toBe(false);
	});

	// Catches: `a/**/b.ts` becoming `a/.*b.ts`, which matches `a/xb.ts`.
	it("`a/**/b` matches zero or more directories between, not a suffix of the basename", () => {
		const re = globToRegExp("a/**/b.ts");
		expect(re.test("a/b.ts")).toBe(true);
		expect(re.test("a/x/y/b.ts")).toBe(true);
		expect(re.test("a/xb.ts")).toBe(false);
	});
});

describe("linguist-generated attribute semantics (critic round 2)", () => {
	// Catches: `-linguist-generated` / `=false` treated as "generated".
	it("an unset or false attribute does not mark a pattern generated", () => {
		const text = ["a.txt -linguist-generated", "b.txt linguist-generated=false", "c.txt linguist-generated=true"].join(
			"\n",
		);
		expect(parseLinguistGenerated(text)).toEqual(["c.txt"]);
	});

	// Catches: a later `-linguist-generated` line for one file being ignored, so a file
	// the repo explicitly un-generated stays collapsed in review.
	it("a later unset line overrides an earlier pattern for the same path", () => {
		const patterns = parseLinguistGenerated(
			["gen/** linguist-generated", "gen/keep.ts -linguist-generated"].join("\n"),
		);
		expect(classifyDiffFile("gen/other.ts", patterns)).toBe("generated");
		expect(classifyDiffFile("gen/keep.ts", patterns)).toBeNull();
	});
});

describe("classifyDiffFile boundaries (critic round 2)", () => {
	// Catches: substring matches on directory names collapsing real source.
	it.each(["src/latest/foo.ts", "src/contest/a.ts", "src/testing/a.ts", "src/inspect/a.ts", "src/specs.ts"])(
		"%s is read, not collapsed",
		(path) => {
			expect(classifyDiffFile(path)).toBeNull();
		},
	);
});
