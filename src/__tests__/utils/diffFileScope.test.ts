import { describe, expect, it } from "vitest";
import { classifyDiffFile, globToRegExp, parseLinguistGenerated } from "../../utils/diffFileScope";

describe("classifyDiffFile", () => {
	it.each([
		["pnpm-lock.yaml", "lockfile"],
		["src-tauri/Cargo.lock", "lockfile"],
		["web/package-lock.json", "lockfile"],
		["dist/app.js", "generated"],
		["src/api.pb.go", "generated"],
		["src/__tests__/foo.ts", "test"],
		["src/foo.test.tsx", "test"],
		["pkg/foo_test.go", "test"],
		["tests/test_foo.py", "test"],
		["src/main.ts", null],
		["src/contest.ts", null],
		["src/latest/readme.md", null],
	])("%s -> %s", (path, scope) => {
		expect(classifyDiffFile(path)).toBe(scope);
	});

	it("honours linguist-generated patterns from .gitattributes", () => {
		const patterns = parseLinguistGenerated(
			"# c\n*.gen.ts linguist-generated\nsrc/schema/** linguist-generated=true\n*.md text\nkeep.ts -linguist-generated\n",
		);
		// The later unset line is kept as a `!` override: last matching line wins.
		expect(patterns).toEqual(["*.gen.ts", "src/schema/**", "!keep.ts"]);
		expect(classifyDiffFile("a/b/x.gen.ts", patterns)).toBe("generated");
		expect(classifyDiffFile("src/schema/deep/x.ts", patterns)).toBe("generated");
		expect(classifyDiffFile("keep.ts", patterns)).toBeNull();
	});
});

describe("globToRegExp", () => {
	it("a slash-less pattern matches the basename at any depth; * does not cross /", () => {
		expect(globToRegExp("*.gen.ts").test("a/b/x.gen.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
		expect(globToRegExp("src/*.ts").test("src/b.ts")).toBe(true);
	});
});
