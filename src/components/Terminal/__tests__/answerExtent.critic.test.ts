import { describe, expect, it } from "vitest";
import { buildAnswersTurn } from "../answersTurn";
import { planSuggestOverlay, type RowSnapshot } from "../suggestOverlay";

function rows(...text: string[]): RowSnapshot[] {
	return text.map((text) => ({ text, isWrapped: false }));
}

describe("answer extent adversarial boundaries", () => {
	// Catches: indentation makes a new user prompt leak into copied answer text.
	it("ends the answer before an indented user prompt", () => {
		const input = rows("⏺ 💬 Done.", "  Details.", "  ❯ Next question");
		expect(buildAnswersTurn(input, false).answers).toEqual(["💬 Done.\nDetails."]);
	});

	// Catches: a literal marker inside fenced answer content splits one answer in two.
	it("keeps a literal marker inside fenced code in the same answer", () => {
		const input = rows("⏺ 💬 Example:", "  ```text", "  💬 literal token", "  ```", "  Explanation.", "⏺ Tool call");
		expect(buildAnswersTurn(input, false).answers).toEqual([
			"💬 Example:\n```text\n💬 literal token\n```\nExplanation.",
		]);
	});

	// Catches: a literal agent bullet inside fenced answer content prematurely ends the tint.
	it("tints every row of fenced content containing a literal agent bullet", () => {
		const input = rows("⏺ 💬 Example:", "  ```text", "  ⏺ literal bullet", "  ```", "  Explanation.", "⏺ Tool call");
		expect(planSuggestOverlay(input.length, (i) => input[i] ?? null).blocks).toEqual([
			{ row: 0, kind: "answer" },
			{ row: 1, kind: "answer" },
			{ row: 2, kind: "answer" },
			{ row: 3, kind: "answer" },
			{ row: 4, kind: "answer" },
		]);
	});
});
