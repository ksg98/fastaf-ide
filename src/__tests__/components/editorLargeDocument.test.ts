import { describe, expect, it } from "vitest";
import { isLargeDocument, languageTarget } from "../../components/CodeEditorPanel/CodeEditorTab";

const LIMIT = 500 * 1024;

describe("isLargeDocument", () => {
	it("keeps the full editor up to the threshold", () => {
		expect(isLargeDocument(0)).toBe(false);
		expect(isLargeDocument(LIMIT)).toBe(false);
	});

	it("switches to plain text one character past it", () => {
		expect(isLargeDocument(LIMIT + 1)).toBe(true);
		expect(isLargeDocument(23 * 1024 * 1024)).toBe(true);
	});
});

describe("languageTarget", () => {
	it("names the file to detect once a normal-sized document is loaded", () => {
		expect(languageTarget("src/a.json", false, 1024)).toBe("src/a.json");
	});

	it("is null while the content is still loading, whatever the previous document held", () => {
		// The regression: the old guard read the previous file's (empty) content and
		// attached JSON highlighting to a 23 MB document.
		expect(languageTarget("mutants.json", true, 0)).toBeNull();
		expect(languageTarget("mutants.json", true, 1024)).toBeNull();
	});

	it("is null for a large document even after it loaded", () => {
		expect(languageTarget("mutants.json", false, 23 * 1024 * 1024)).toBeNull();
	});

	it("is null without a file", () => {
		expect(languageTarget("", false, 10)).toBeNull();
	});
});
