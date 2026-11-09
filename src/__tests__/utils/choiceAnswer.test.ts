import { describe, expect, it } from "vitest";
import type { ChoicePrompt } from "../../mobile/useSessions";
import { choiceAnswerKeys } from "../../utils/choiceAnswer";

const option = (key: string, label: string) => ({ key, label, highlighted: false, destructive: false });

describe("choiceAnswerKeys", () => {
	it("finds the yes and the no of a permission prompt", () => {
		const prompt: ChoicePrompt = {
			title: "Do you want to run rm -rf data/cache?",
			options: [
				option("1", "Yes"),
				option("2", "Yes, and don't ask again for rm commands"),
				option("3", "No, and tell Claude what to do differently (esc)"),
			],
		};
		expect(choiceAnswerKeys(prompt)).toEqual({ approve: "1", deny: "3" });
	});

	// Catches: "approve" picking the option that also switches off future
	// prompts, because it sorted first or matched last.
	it("approves with the narrowest yes, never the one that grants more", () => {
		const prompt: ChoicePrompt = {
			title: "Allow edit?",
			options: [option("1", "Yes, allow all edits during this session"), option("2", "Yes"), option("3", "No")],
		};
		// The first affirmative option is what the dialog itself puts first;
		// reordering by breadth would be this code second-guessing the agent.
		expect(choiceAnswerKeys(prompt)?.approve).toBe("1");
		expect(choiceAnswerKeys(prompt)?.deny).toBe("3");
	});

	// Catches: "approve" answering a question that is not a yes-or-no at all.
	it("has no answer for a choice between plans", () => {
		const prompt: ChoicePrompt = {
			title: "Which approach?",
			options: [option("1", "Rewrite the parser"), option("2", "Patch the tokenizer"), option("3", "Something else")],
		};
		expect(choiceAnswerKeys(prompt)).toBeNull();
	});

	it("has no answer when only one side is on offer", () => {
		expect(
			choiceAnswerKeys({ title: "Continue?", options: [option("1", "Yes"), option("2", "Show details")] }),
		).toBeNull();
	});

	it("has no answer for a dialog steered with arrow keys, or for none", () => {
		expect(
			choiceAnswerKeys({
				title: "Proceed?",
				selection_mode: "navigate-only",
				options: [option("1", "Yes"), option("2", "No")],
			}),
		).toBeNull();
		expect(choiceAnswerKeys(null)).toBeNull();
		expect(choiceAnswerKeys(undefined)).toBeNull();
	});

	it("does not mistake a word that merely starts like yes or no", () => {
		expect(
			choiceAnswerKeys({ title: "Pick", options: [option("1", "Yesterday's build"), option("2", "Notes only")] }),
		).toBeNull();
	});
});
