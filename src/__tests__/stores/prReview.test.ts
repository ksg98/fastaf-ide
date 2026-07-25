import { describe, expect, it } from "vitest";
import type { FileClassification, Finding } from "../../stores/aiTriageStore";
import { flattenReviewFindings, isPostable, postableFindings } from "../../stores/prReview";

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		path: "src/a.ts",
		line: 10,
		hunk: null,
		severity: "bug",
		message: "boom",
		confidence: 0.9,
		...overrides,
	};
}

function file(overrides: Partial<FileClassification> = {}): FileClassification {
	return {
		path: "src/a.ts",
		relevance: "high",
		category: "business-logic",
		risk: "behavioral-change",
		summary: "the file",
		source: "llm",
		additions: 1,
		deletions: 0,
		...overrides,
	};
}

describe("flattenReviewFindings", () => {
	it("flattens per-file findings into an ordered list, preserving severity/confidence/message", () => {
		const files: FileClassification[] = [
			file({ path: "src/a.ts", summary: "A", findings: [finding({ path: "src/a.ts", severity: "bug" })] }),
			file({
				path: "src/b.ts",
				summary: "B",
				findings: [
					finding({ path: "src/b.ts", severity: "risk", line: 3, confidence: 0.75 }),
					finding({ path: "src/b.ts", severity: "nit", line: 4 }),
				],
			}),
		];
		const out = flattenReviewFindings(files);
		expect(out).toHaveLength(3);
		expect(out.map((f) => f.severity)).toEqual(["bug", "risk", "nit"]);
		// confidence and message survive the flatten unchanged (no re-filtering)
		expect(out[1].confidence).toBe(0.75);
		expect(out[1].message).toBe("boom");
		// each finding carries its owning file's summary for context
		expect(out[0].fileSummary).toBe("A");
		expect(out[1].fileSummary).toBe("B");
	});

	it("produces stable, unique ids per (path, line, per-file index)", () => {
		const files: FileClassification[] = [
			file({
				path: "src/a.ts",
				findings: [
					finding({ path: "src/a.ts", line: 10 }),
					finding({ path: "src/a.ts", line: 10 }), // same line, different index
				],
			}),
		];
		const out = flattenReviewFindings(files);
		expect(out[0].id).toBe("src/a.ts:10:0");
		expect(out[1].id).toBe("src/a.ts:10:1");
		expect(new Set(out.map((f) => f.id)).size).toBe(2);
		// a re-flatten of the same input yields identical ids (selection survives)
		expect(flattenReviewFindings(files).map((f) => f.id)).toEqual(out.map((f) => f.id));
	});

	it("uses 'file' in the id for line-less (file-level) findings", () => {
		const out = flattenReviewFindings([file({ findings: [finding({ path: "src/a.ts", line: null })] })]);
		expect(out[0].id).toBe("src/a.ts:file:0");
	});

	it("returns an empty list when no file has findings", () => {
		expect(flattenReviewFindings([file({ findings: [] }), file({ findings: undefined })])).toEqual([]);
	});
});

describe("postableFindings — GitHub inline-comment gate", () => {
	it("returns only findings that are BOTH selected AND anchored to a line", () => {
		const flat = flattenReviewFindings([
			file({
				path: "src/a.ts",
				findings: [
					finding({ path: "src/a.ts", line: 10 }), // id ...:10:0
					finding({ path: "src/a.ts", line: null }), // id ...:file:1 — not postable
				],
			}),
		]);
		const allSelected = new Set(flat.map((f) => f.id));
		const postable = postableFindings(flat, allSelected);
		// the line-less finding is excluded even though it's selected
		expect(postable).toHaveLength(1);
		expect(postable[0].line).toBe(10);
	});

	it("excludes findings that are unselected", () => {
		const flat = flattenReviewFindings([
			file({ path: "src/a.ts", findings: [finding({ path: "src/a.ts", line: 10 })] }),
		]);
		expect(postableFindings(flat, new Set())).toHaveLength(0);
	});

	it("post gate is empty when nothing is selectable", () => {
		const flat = flattenReviewFindings([
			file({ path: "src/a.ts", findings: [finding({ path: "src/a.ts", line: null })] }),
		]);
		expect(postableFindings(flat, new Set(flat.map((f) => f.id)))).toHaveLength(0);
	});
});

describe("isPostable", () => {
	it("is true only for findings with a concrete line", () => {
		expect(isPostable({ line: 5 })).toBe(true);
		expect(isPostable({ line: null })).toBe(false);
	});
});
