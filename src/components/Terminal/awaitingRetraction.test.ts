import { describe, expect, it } from "vitest";
import { shouldRetractAwaiting } from "./awaitingRetraction";

describe("shouldRetractAwaiting", () => {
	const base = { awaitingInput: "question", awaitingInputConfident: false };

	it("drops a heuristic question the backend saw leave the screen", () => {
		// The observed bug: codex asked "Would you like to make the following
		// edits?", Boss answered with a bare Enter, and nothing else ever cleared
		// the badge — no user-input (nothing typed), no status-line, no choice
		// prompt to resolve. This retraction is the only path left.
		expect(shouldRetractAwaiting(base)).toBe(true);
	});

	it("keeps a confident question", () => {
		// grok repaints while it waits: gone from one frame is not answered.
		expect(shouldRetractAwaiting({ ...base, awaitingInputConfident: true })).toBe(false);
	});

	it("keeps an error badge", () => {
		// "error" is set by the frontend alone (usage-exhausted, api-error). The
		// backend does not track it, so its question retraction must not wipe it.
		expect(shouldRetractAwaiting({ ...base, awaitingInput: "error" })).toBe(false);
	});

	it("is a no-op when nothing is awaiting", () => {
		expect(shouldRetractAwaiting({ ...base, awaitingInput: null })).toBe(false);
		expect(shouldRetractAwaiting({ ...base, awaitingInput: undefined })).toBe(false);
	});
});
