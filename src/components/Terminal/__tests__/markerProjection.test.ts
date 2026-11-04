import { describe, expect, it } from "vitest";
import { type DecodedRow, decodeBinaryFrame, rowText } from "../canvasTerminalUtils";
import { hiddenMarkerRows, planSuggestOverlay } from "../suggestOverlay";
import claude from "./fixtures/claude-markers-1873.json";
import paragraphs from "./fixtures/codex-answer-paragraphs-1872.json";
import codex from "./fixtures/codex-markers-1873.json";
import { metrics, painter } from "./gridPaintTestUtils";

function decode(frames: string[]) {
	const rows = new Map<number, DecodedRow>();
	for (const base64 of frames) {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const frame = decodeBinaryFrame(bytes.buffer, rows);
		if (!frame) throw new Error("Invalid recorded terminal frame");
		for (const row of frame.rows) rows.set(row.index, row);
	}
	return rows;
}

describe("recorded terminal marker layout", () => {
	for (const capture of [claude, codex]) {
		it(`${capture.source.agent}: keeps intent rows paintable`, () => {
			// Catches: filtering intent together with suggest hides visible progress.
			const rows = decode(capture.frames);
			const plan = planSuggestOverlay(rows.size, (i) => {
				const row = rows.get(i);
				return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
			});
			const { renderer, textAt } = painter();
			renderer.paintGrid(rows, metrics, {
				fullRepaint: true,
				hiddenRows: hiddenMarkerRows(plan.blocks),
				hiddenAnswerMarkers: plan.answerMarkers,
			});
			const baseline = capture.source.agent === "claude" ? 235 : 415;
			expect(textAt(baseline, 2)).toBe("intent: Verifying terminal display (Display check)");
		});
		it(`${capture.source.agent}: removes the suggest and hard-wrap rows`, () => {
			// Catches: blanking the marker leaves layout holes or hides intent.
			const rows = decode(capture.frames);
			const plan = planSuggestOverlay(rows.size, (i) => {
				const row = rows.get(i);
				return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
			});
			const intent = [...rows.values()].find((r) => /^[⏺•] intent:/.test(rowText(r)))!;
			const suggest = plan.blocks.find((b) => b.kind === "suggest" && b.row > intent.index)!;
			const tail = plan.blocks.find((b) => b.kind === "continuation" && b.row > suggest.row)!;
			const { renderer, fillText } = painter();
			renderer.paintGrid(rows, metrics, {
				fullRepaint: true,
				hiddenRows: hiddenMarkerRows(plan.blocks.filter((b) => b.kind !== "intent")),
				hiddenAnswerMarkers: plan.answerMarkers,
			});

			const nextRow = rows.get(tail.row + 2)!;
			const first = [...nextRow.codepoints].findIndex((cp) => cp !== 0 && cp !== 32);
			expect(first).toBeGreaterThanOrEqual(0);
			const glyph =
				String.fromCodePoint(nextRow.codepoints[first]) + (nextRow.codepoints[first] === 0x273b ? "\uFE0E" : "");
			// Only the output suggest is omitted; the prompt quotation stays visible.
			expect(fillText).toHaveBeenCalledWith(glyph, first * 10, (nextRow.index - 2) * 20 + 15);
		});
	}
	it("marked paragraph starts use the same indent as unmarked continuations", () => {
		// Catches: hiding the wide glyph leaves its two cells and trailing space blank.
		const rows = decode([paragraphs.frameBase64]);
		const marked = [...rows.values()].filter(
			(r) => /^[• ]+💬/.test(rowText(r)) && !rowText(r).includes("Do not use tools"),
		);
		expect(marked.length).toBe(3);
		const { renderer, fillText } = painter();
		for (const row of marked) {
			renderer.paintRow(row, row.index * 20, metrics, undefined, true);
			const col = row.codepoints.indexOf(0x1f4ac);
			const letter = [...row.codepoints].slice(col + 1).find((cp) => cp !== 0 && cp !== 32)!;
			expect(fillText).toHaveBeenCalledWith(String.fromCodePoint(letter), 20, row.index * 20 + 15);
		}
	});
});

it("removes the marker indent on both real Claude paragraphs while the second wraps", async () => {
	// Catches: later marked paragraphs retaining three blank cells after the bullet.
	const capture = (await import("./fixtures/claude-wrapped-answer-1873.json")).default;
	const rows = decode(capture.frames);
	const plan = planSuggestOverlay(rows.size, (i) => {
		const row = rows.get(i);
		return row ? { text: rowText(row), isWrapped: rows.get(i - 1)?.wrapped ?? false } : null;
	});
	const { renderer, fillText } = painter();
	const answers = [...rows.values()].filter((row) => /💬.*The (first|second) answer/.test(rowText(row)));
	expect(answers).toHaveLength(2);
	for (const row of answers) {
		fillText.mockClear();
		renderer.paintRow(row, 0, metrics, undefined, plan.answerMarkers.has(row.index));
		expect(fillText.mock.calls.find(([glyph]) => glyph === "T")?.[1]).toBe(20);
	}
	const second = answers[1];
	expect(rowText(rows.get(second.index + 1)!)).toContain("enough to wrap");
});
