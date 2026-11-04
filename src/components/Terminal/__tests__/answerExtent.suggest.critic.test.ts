import { describe, expect, it } from "vitest";
import { buildAnswersTurn } from "../answersTurn";
import { planSuggestOverlay, type RowSnapshot } from "../suggestOverlay";

function rows(...text: string[]): RowSnapshot[] {
	return text.map((text) => ({ text, isWrapped: false }));
}

// Claude indents every paragraph after the bullet row, so the turn-closing
// `suggest:` token sits indented inside the same message as the 💬 answer.
describe("answer extent vs protocol tokens in the same message", () => {
	// Catches: the answer tint swallows an indented `suggest:` row, so the overlay never masks it and no chips are offered.
	it("still plans an indented suggest row after an answer as a suggest block", () => {
		const input = rows("⏺ 💬 Done.", "", "  suggest: [ Run tests | Open PR | Stop ]");
		const { blocks } = planSuggestOverlay(input.length, (i) => input[i] ?? null);
		expect(blocks).toContainEqual({ row: 2, kind: "suggest" });
		expect(blocks).not.toContainEqual({ row: 2, kind: "answer" });
	});

	// Catches: the suggest token leaking into the copied answers-only text.
	it("keeps an indented suggest row out of the answers-only text", () => {
		const input = rows("⏺ 💬 Done.", "", "  suggest: [ Run tests | Open PR | Stop ]");
		expect(buildAnswersTurn(input, false).answers).toEqual(["💬 Done."]);
	});
});
