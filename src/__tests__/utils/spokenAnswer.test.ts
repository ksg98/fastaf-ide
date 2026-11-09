import { describe, expect, it } from "vitest";
import { spokenAnswer } from "../../utils/spokenAnswer";

describe("spokenAnswer", () => {
	it.each(["yes", "Yes.", "Yeah", "approve", "Approve it.", "go ahead", "OK", "okay!", "Yes, please"])(
		"hears %j as yes",
		(text) => {
			expect(spokenAnswer(text)).toBe(true);
		},
	);

	it.each(["no", "No.", "nope", "deny", "Deny it", "don't", "Don’t", "do not", "cancel", "No, stop"])(
		"hears %j as no",
		(text) => {
			expect(spokenAnswer(text)).toBe(false);
		},
	);

	// Catches: a real instruction that happens to start with yes or no being
	// swallowed as the answer to a pending approval.
	it.each([
		"no, use the staging database instead",
		"yes but only for the tests folder",
		"approve it and then run the build",
		"what does that command do",
	])("does not hear %j as an answer", (text) => {
		expect(spokenAnswer(text)).toBeNull();
	});

	it("does not answer on silence or noise", () => {
		expect(spokenAnswer("")).toBeNull();
		expect(spokenAnswer("   ")).toBeNull();
		expect(spokenAnswer("...")).toBeNull();
	});

	// Catches: "know" or "yesterday" matching on a prefix.
	it("matches whole phrases only", () => {
		expect(spokenAnswer("know")).toBeNull();
		expect(spokenAnswer("yesterday")).toBeNull();
		expect(spokenAnswer("nobody")).toBeNull();
	});
});
