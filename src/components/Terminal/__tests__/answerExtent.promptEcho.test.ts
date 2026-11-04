import { describe, expect, it } from "vitest";
import { buildAnswersTurn } from "../answersTurn";
import { planSuggestOverlay } from "../suggestOverlay";
import recorded from "./fixtures/claude-prompt-answer-1389.json";

const prompt = recorded.rows.findIndex((text) => text.startsWith("❯"));
const answer = recorded.rows.findIndex((text) => text.startsWith("⏺ 💬"));

function screen(promptMarker: boolean, answerMarker: boolean) {
	return recorded.rows.slice(prompt).map((text, index) => ({
		text: (index < answer - prompt ? promptMarker : answerMarker) ? text : text.replaceAll("💬", ""),
		isWrapped: false,
	}));
}

describe("recorded Claude prompt echo answer boundaries", () => {
	// Catches: the quoted marker opens a fake answer and its gutter joins the real answer.
	it("never highlights or copies the prompt echo as an answer", () => {
		const rows = screen(true, true);
		const start = answer - prompt;
		const plan = planSuggestOverlay(rows.length, (i) => rows[i] ?? null);
		expect(plan.blocks.filter((block) => block.kind === "answer").map((block) => block.row)).toEqual(
			Array.from({ length: 7 }, (_, i) => start + i),
		);
		expect([...plan.answerMarkers]).toEqual([start]);
		const turn = buildAnswersTurn(rows, true);
		expect(turn.prompt).toBe(
			rows
				.slice(0, start)
				.map((row) => row.text.trimEnd())
				.join("\n")
				.trimEnd(),
		);
		expect(turn.answers).toHaveLength(1);
		expect(turn.answers[0]).toBe(
			rows
				.slice(start, start + 7)
				.map((row) => row.text.slice(2))
				.join("\n"),
		);
	});

	// Catches: a prompt-only marker invents an answer when the agent omits its marker.
	it("does not promote a prompt marker when the actual answer is unmarked", () => {
		const rows = screen(true, false);
		expect(planSuggestOverlay(rows.length, (i) => rows[i] ?? null).blocks).toEqual([]);
		expect(buildAnswersTurn(rows, true).answers).toEqual([]);
	});

	// Catches: excluding quoted markers also excludes genuine marked output after a plain prompt.
	it("keeps the marked answer after a prompt without a marker", () => {
		const rows = screen(false, true);
		expect([...planSuggestOverlay(rows.length, (i) => rows[i] ?? null).answerMarkers]).toEqual([answer - prompt]);
		expect(buildAnswersTurn(rows, true).answers).toHaveLength(1);
	});
	// Catches: the prompt preview limit exposing quoted markers late in long pasted prompts.
	it("excludes quoted markers beyond the prompt preview limit and without prompt tracking", () => {
		const rows = screen(true, true);
		rows.splice(1, 0, ...Array.from({ length: 60 }, () => ({ text: "  pasted context", isWrapped: false })));
		for (const hasPrompt of [true, false]) {
			const turn = buildAnswersTurn(rows, hasPrompt);
			expect(turn.answers).toHaveLength(1);
			expect(turn.answers[0]).not.toContain("Then stop.");
		}
		expect([...planSuggestOverlay(rows.length, (i) => rows[i] ?? null).answerMarkers]).toEqual([answer - prompt + 60]);
	});
});
