import { describe, expect, it } from "vitest";
import { answerExtent, planSuggestOverlay, type RowSnapshot } from "../suggestOverlay";
import codex from "./fixtures/codex-answer-paragraphs-1872.json";
import claude from "./fixtures/wtnxt-list-answers-1904.json";

const snapshots = (text: string): RowSnapshot[] => text.split("\n").map((text) => ({ text, isWrapped: false }));
const gutterRows = (rows: RowSnapshot[]) =>
	planSuggestOverlay(rows.length, (i) => rows[i] ?? null)
		.blocks.filter((b) => b.kind === "answer")
		.map((b) => b.row);

describe("answer gutter continuity (#1998-d826)", () => {
	// Catches: blank-prose boundaries and separate marked list scopes leave holes inside a real Claude answer.
	it("keeps the recorded Claude answer gutter continuous across blank rows", () => {
		const rows = snapshots(claude.text);
		const last = rows.findLastIndex((row) => row.text.trim() !== "");
		expect(gutterRows(rows)).toEqual(Array.from({ length: last + 1 }, (_, i) => i));
	});

	// Catches: visual joining leaks into trailing unmarked prose or changes the semantic answer boundary.
	it("leaves trailing blank-separated unmarked prose outside the gutter and answer", () => {
		const rows = snapshots("⏺ 💬 Answer.\n\n  Unmarked status.\n\n");
		expect(gutterRows(rows)).toEqual([0]);
		expect(answerExtent(0, rows.length, (i) => rows[i] ?? null)).toBe(0);
	});

	// Catches: joining separate answers across a real response boundary paints non-answer output.
	it.each(["⏺ Read file", "  ❯ Next prompt", "  intent: Working (Work)", "  Worked for 7s", "plain output"])(
		"does not bridge across %s",
		(boundary) => {
			const rows = snapshots(`⏺ 💬 First.\n\n${boundary}\n\n  💬 Second.`);
			expect(gutterRows(rows)).toEqual([0, 4]);
		},
	);

	// Catches: joining list answers colors an unmarked trailing sibling.
	it("stops after the last marked list item even at the screen bottom", () => {
		const rows = snapshots("  - 💬 First.\n\n  - 💬 Second.\n  - Unmarked sibling.");
		expect(gutterRows(rows)).toEqual([0, 1, 2]);
		expect(gutterRows(rows.slice(0, 3))).toEqual([0, 1, 2]);
	});

	// Catches: visual joining colors an unmarked sibling between two list answers.
	it("does not bridge an unmarked sibling before a later answer", () => {
		const rows = snapshots("  - 💬 First.\n\n  - Unmarked sibling.\n\n  - 💬 Second.");
		expect(gutterRows(rows)).toEqual([0, 4]);
	});

	// Catches: the gutter policy accidentally requires Claude indentation for native ego rows.
	it("joins native ego answer paragraphs without trailing blanks", () => {
		expect(gutterRows(snapshots("💬 First.\n\n💬 Second.\n\n"))).toEqual([0, 1, 2]);
	});

	// Catches: the gutter join adds the Codex footer or trailing blanks to the recorded answer.
	it("preserves the recorded Codex paragraph extent", () => {
		const rows = snapshots(codex.rows.join("\n"));
		expect(gutterRows(rows)).toEqual([18, 19, 20, 21, 22]);
	});
});
