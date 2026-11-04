// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildAnswersTurn } from "../answersTurn";
import { type DecodedRow, rowText } from "../canvasTerminalUtils";
import { paintOverlayBlocks, planSuggestOverlay } from "../suggestOverlay";
import { ViewportProjection } from "../viewportProjection";
import recordedWtnxt from "./fixtures/wtnxt-list-answers-1904.json";

describe("list answer regressions", () => {
	it.each(["-", "*", "+", "1.", "2)"])("recognizes %s answers without swallowing sibling items", (bullet) => {
		const texts = [
			`  ${bullet} 💬 Answer.`,
			"     hard-wrapped continuation",
			"",
			"     - nested detail",
			`  ${bullet} Unmarked sibling.`,
			"    sibling continuation",
			"  Unmarked prose.",
		];
		const rows = texts.map((text) => ({ text, isWrapped: false }));
		const plan = planSuggestOverlay(rows.length, (i) => rows[i] ?? null);
		expect(plan.blocks).toEqual([0, 1, 2, 3].map((row) => ({ row, kind: "answer" })));
		expect([...plan.answerMarkers]).toEqual([0]);
		expect(buildAnswersTurn(rows, false).answers).toEqual([
			`${bullet} 💬 Answer.\n   hard-wrapped continuation\n\n   - nested detail`,
		]);
		const cp = Uint32Array.from([...texts[0]].map((c) => c.codePointAt(0)!));
		const decoded = {
			index: 0,
			count: cp.length,
			codepoints: cp,
			fg: new Uint32Array(cp.length),
			bg: new Uint32Array(cp.length),
			attrs: new Uint8Array(cp.length),
		} as DecodedRow;
		const projection = new ViewportProjection(new Map([[0, decoded]]), new Set(), plan.answerMarkers);
		expect(rowText(projection.projectRow(decoded)!)).toBe(`  ${bullet} Answer.`);
		const container = document.createElement("div");
		paintOverlayBlocks(container, plan.blocks, 20);
		expect(container.children).toHaveLength(4);
		expect((container.firstElementChild as HTMLElement).style.boxShadow).toContain("var(--answer-rule)");
	});
});

// Catches: a second marked sibling being swallowed by the first item's scope.
it("separates marked sibling answers and retains soft wraps", () => {
	const rows = [
		{ text: "- 💬 First", isWrapped: false },
		{ text: " continued", isWrapped: true },
		{ text: "- 💬 Second", isWrapped: false },
		{ text: "  tail", isWrapped: false },
		{ text: "Outside", isWrapped: false },
	];
	expect(buildAnswersTurn(rows, false).answers).toEqual(["- 💬 First continued", "- 💬 Second\ntail"]);
	expect([...planSuggestOverlay(rows.length, (i) => rows[i] ?? null).answerMarkers]).toEqual([0, 2]);
});

// Catches: a quoted marker or a marker in the middle of item text opening an answer.
it("ignores quoted markers and markers inside item prose", () => {
	const rows = ["> - 💬 example", "- literal 💬 example", "1. ordinary item"].map((text) => ({
		text,
		isWrapped: false,
	}));
	expect(buildAnswersTurn(rows, false).answers).toEqual([]);
	expect(planSuggestOverlay(rows.length, (i) => rows[i] ?? null).blocks).toEqual([]);
});

// Catches: the reported Claude list answers disappearing, or gutter headings becoming extracted answers.
it("joins the recorded WTNXT gutter without extracting its headings as answers", () => {
	const rows = recordedWtnxt.text
		.trimEnd()
		.split("\n")
		.map((text) => ({ text, isWrapped: false }));
	const plan = planSuggestOverlay(rows.length, (i) => rows[i] ?? null);
	const markerRows = rows.flatMap((row, i) => (row.text.includes("💬") ? [i] : []));
	expect(markerRows).toHaveLength(11);
	expect([...plan.answerMarkers]).toEqual(markerRows);
	const answerRows = new Set(plan.blocks.filter((b) => b.kind === "answer").map((b) => b.row));
	for (const [i, row] of rows.entries()) {
		if (row.text.includes("Correzioni all'") || row.text.includes("Proposte principali"))
			expect(answerRows.has(i)).toBe(true);
		if (/^ {4}- /.test(row.text)) expect(answerRows.has(i)).toBe(true);
	}
	const turn = buildAnswersTurn(rows, false);
	expect(turn.answers).toHaveLength(11);
	expect(turn.answers[0]).toContain("Ho scritto la bozza");
	expect(turn.answers.join("\n")).not.toContain("Correzioni all'");
	expect(turn.answers.join("\n")).not.toContain("Proposte principali");
	expect(turn.answers.find((answer) => answer.includes("LLM su due livelli"))).toContain(
		"Lo stato dell'intervista resta",
	);
});
