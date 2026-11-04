import { expect, it } from "vitest";
import { stripAnswerMarkers } from "../../utils/stripAnswerMarkers";

// Catches: using a global emoji replacement destroys literal content and list structure.
it("strips only row/list prefixes while retaining agent bullets, indentation, CRLF and inline emoji", () => {
	expect(stripAnswerMarkers("  ● 💬 One 💬.\r\n  2) 💬 Two\r\n- 💬 Three\r\n> 💬 quote")).toBe(
		"  ● One 💬.\r\n  2) Two\r\n- Three\r\n> 💬 quote",
	);
});

// Catches: copying a fenced example silently changes its literal contents.
it("preserves markers in backtick and tilde fences but strips following answers", () => {
	expect(
		stripAnswerMarkers("````text\n💬 literal\n```\n💬 still literal\n````\n~~~\n- 💬 example\n~~~\n💬 Answer"),
	).toBe("````text\n💬 literal\n```\n💬 still literal\n````\n~~~\n- 💬 example\n~~~\nAnswer");
});
