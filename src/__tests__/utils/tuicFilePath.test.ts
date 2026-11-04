import { describe, expect, it } from "vitest";
import { detectOutputLinks } from "../../mobile/utils/outputLinks";
import { parseTuicFilePath } from "../../utils/tuicFilePath";

describe("tuic file URL pathname boundary", () => {
	// Catches: collapsing the URL delimiter loses an absolute root, or corrupts a drive/UNC path.
	it.each([
		["//Users/boss/x.md", "/Users/boss/x.md"],
		["///Users/boss/x.md", "/Users/boss/x.md"],
		["////home/boss/x.md", "/home/boss/x.md"],
		["/docs/x.md", "docs/x.md"],
		["/C:/Users/boss/x.md", "C:/Users/boss/x.md"],
		["/%5C%5Cserver%5Cshare%5Cx.md", String.raw`\\server\share\x.md`],
		["/%2F%2FUsers/boss/a%20b.md", "/Users/boss/a b.md"],
		["//", "/"],
		["/", ""],
	])("decodes %s to %s", (pathname, expected) => {
		expect(parseTuicFilePath(pathname)).toBe(expected);
	});

	// Catches: mobile Markdown controls bypass root normalization before filesystem resolution.
	it("normalizes the candidate of a mobile output deep link", () => {
		expect(detectOutputLinks("Read tuic://open///home/boss/x.md?line=12")).toEqual([
			expect.objectContaining({ kind: "markdown", candidate: "/home/boss/x.md", line: 12 }),
		]);
	});

	// Catches: invalid percent escapes silently become a different filesystem path.
	it("rejects malformed URL encoding", () => {
		expect(() => parseTuicFilePath("//home/boss/%ZZ.md")).toThrow(URIError);
	});
});
