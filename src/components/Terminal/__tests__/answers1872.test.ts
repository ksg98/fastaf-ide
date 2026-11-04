import { describe, expect, it, vi } from "vitest";
import { buildAnswersTurn, rowCopyText } from "../answersTurn";
import {
	ATTR_DEFAULT_BG,
	ATTR_DEFAULT_FG,
	type CellMetrics,
	type DecodedRow,
	decodeBinaryFrame,
	rowText,
} from "../canvasTerminalUtils";
import { createGridRenderer } from "../gridRenderer";
import {
	answerBlockRanges,
	answerExtent,
	hiddenMarkerRows,
	planSuggestOverlay,
	type RowSnapshot,
} from "../suggestOverlay";
import recordedCodex from "./fixtures/codex-answer-paragraphs-1872.json";

const snapshots = (texts: string[]): RowSnapshot[] => texts.map((text) => ({ text, isWrapped: false }));
const metrics: CellMetrics = {
	cellWidth: 8,
	cellHeight: 16,
	baseline: 12,
	fontSize: 14,
	dpr: 1,
	scaledCellWidth: 8,
	scaledCellHeight: 16,
};
function decoded(text: string, index: number): DecodedRow {
	const cps = [...text].flatMap((ch) => (ch === "💬" ? [0x1f4ac, 0] : [ch.codePointAt(0)!]));
	return {
		index,
		count: cps.length,
		wrapped: false,
		codepoints: Uint32Array.from(cps),
		fg: new Uint32Array(cps.length),
		bg: new Uint32Array(cps.length),
		attrs: new Uint8Array(cps.length).fill(ATTR_DEFAULT_BG | ATTR_DEFAULT_FG),
	};
}

describe("continuous answer regions (#1872-1870)", () => {
	// Catches: Codex's indented duration footer being tinted and included in answers-only text.
	it("ends the recorded answer before the Codex Worked for footer", () => {
		const frame = decodeBinaryFrame(Uint8Array.from(atob(recordedCodex.frameBase64), (c) => c.charCodeAt(0)).buffer)!;
		const rows = frame.rows.map((row, index) => ({
			text: rowText(row),
			isWrapped: frame.rows[index - 1]?.wrapped ?? false,
		}));
		const first = rows.findIndex((row) => row.text.includes("💬"));
		const last = rows.findLastIndex((row) => row.text.includes("💬"));
		const footer = rows.findIndex((row) => row.text.includes("Worked for"));
		expect(footer).toBeGreaterThan(last);
		expect(answerExtent(first, rows.length, (i) => rows[i] ?? null)).toBe(last);
		expect(planSuggestOverlay(rows.length, (i) => rows[i] ?? null).blocks.some((block) => block.row === footer)).toBe(
			false,
		);
		expect(buildAnswersTurn(rows, false).answers.join("\n")).not.toContain("Worked for");
		expect(
			answerBlockRanges([
				{ kind: "paragraph", text: "Answer.", marker: true },
				{ kind: "paragraph", text: rows[footer].text.trim(), marker: false },
			]),
		).toEqual([[0, 0]]);
	});

	// Catches: treating quoted footer examples or ordinary Worked for prose as terminal status.
	it("preserves footer examples in code and ordinary Worked for prose", () => {
		const rows = snapshots([
			"💬 Answer.",
			"  ```text",
			"  Worked for 7s • 18:58",
			"  ```",
			"  Worked for several years.",
		]);
		expect(answerExtent(0, rows.length, (i) => rows[i] ?? null)).toBe(4);
	});

	// Catches: each marked paragraph ends the answer extent, leaving blank gaps untinted.
	it("merges three marked paragraphs across blank rows without trailing blank tint", () => {
		const rows = [...recordedCodex.answerRows, { text: "", isWrapped: false }];
		const get = (i: number) => rows[i] ?? null;
		expect(answerExtent(0, rows.length, get)).toBe(4);
		expect(planSuggestOverlay(rows.length, get).blocks.map((b) => b.row)).toEqual([0, 1, 2, 3, 4]);
	});

	// Catches: a later agent bullet leaking into the merged answers-only text, or a code example being stripped.
	it("normalizes each merged paragraph bullet and keeps literal code markers", () => {
		const rows = snapshots(["• 💬 First.", "", "• 💬 Second.", "  ```text", "  • 💬 literal", "  ```"]);
		expect(buildAnswersTurn(rows, false).answers).toEqual(["💬 First.\n\n💬 Second.\n```text\n• 💬 literal\n```"]);
	});

	// Catches: an unmarked paragraph after a blank row tinted as part of the answer (Boss screenshot, 2026-10-13).
	it.each([
		{ multiple: false, boundary: "  Da confermare: report di pubblicazione." },
		{ multiple: true, boundary: "  Da confermare: report di pubblicazione." },
		{ multiple: true, boundary: "  ┌──────────┬─────────┐" },
	])(
		"ends the region before blank-separated unmarked output ($boundary, multiple markers=$multiple)",
		({ multiple, boundary }) => {
			const rows = snapshots([
				"● 💬 Hai ragione.",
				"",
				"  💬 Ho riaperto la storia.",
				"  continuation on the next hard row",
				"",
				"  💬 Ho scritto la regola.",
				"",
				boundary,
				"  second row of it",
			]);
			rows[3].isWrapped = true;
			if (!multiple) rows.splice(0, 5);
			const get = (i: number) => rows[i] ?? null;
			expect(answerExtent(0, rows.length, get)).toBe(multiple ? 5 : 0);
			expect(
				planSuggestOverlay(rows.length, get)
					.blocks.filter((b) => b.kind === "answer")
					.map((b) => b.row),
			).toEqual(multiple ? [0, 1, 2, 3, 4, 5] : [0]);
		},
	);

	// Catches: merging across actual tool output, prompts or protocol boundaries.
	it.each([
		"plain output",
		"• Ran make test",
		"❯ next prompt",
		"  ❯ indented prompt",
		"intent: working (Work)",
		"suggest: [ A | B | C ]",
	])("keeps answers separate across %s", (boundary) => {
		const rows = snapshots(["• 💬 First.", "", boundary, "", "• 💬 Second."]);
		const get = (i: number) => rows[i] ?? null;
		expect(answerExtent(0, rows.length, get)).toBe(0);
		expect(
			planSuggestOverlay(rows.length, get)
				.blocks.filter((b) => b.kind === "answer")
				.map((b) => b.row),
		).toEqual([0, 4]);
	});

	// Catches: hiding only one glyph per merged region, or erasing literal markers in code and soft wraps.
	it.each([true, false])("hides every answer glyph while preserving raw rows (full repaint=%s)", (fullRepaint) => {
		const texts = [
			"• 💬 First.",
			"",
			"  💬 Second.",
			"  ```text",
			"  💬 example",
			"  ```",
			"  💬 Third.",
			"💬 wrapped",
		];
		const rows = snapshots(texts);
		rows[7].isWrapped = true;
		const rowMap = new Map(texts.map((text, index) => [index, decoded(text, index)]));
		const plan = planSuggestOverlay(rows.length, (i) => rows[i] ?? null);
		const fillText = vi.fn();
		const ctx = {
			fillText,
			fillRect: vi.fn(),
			canvas: { width: 800, height: 300 },
			globalAlpha: 1,
		} as unknown as CanvasRenderingContext2D;
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		renderer.paintGrid(rowMap, metrics, {
			fullRepaint,
			dirtyIndices: new Set(rowMap.keys()),
			hiddenRows: hiddenMarkerRows(plan.blocks),
			hiddenAnswerMarkers: plan.answerMarkers,
		});
		expect(fillText.mock.calls.filter(([glyph]) => glyph === "💬").map(([, , y]) => y)).toEqual([76, 124]);
		expect(fillText.mock.calls.some(([glyph, x, y]) => glyph === "F" && x === 16 && y === 12)).toBe(true);
		expect(rowCopyText(rowMap.get(0)!)).toBe("• 💬 First.");
		expect(rowText(rowMap.get(2)!)).toContain("💬");
	});
});
