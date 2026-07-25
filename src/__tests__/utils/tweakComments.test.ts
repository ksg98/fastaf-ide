import { describe, expect, it } from "vitest";
import {
	CONVENTION_HEADER,
	ensureConventionHeader,
	findSourceMatch,
	injectTweakSentinels,
	insertTweakComment,
	OverlappingCommentError,
	parseTweakComments,
	removeTweakComment,
	serializeTweakComment,
	type TweakComment,
	toggleCheckbox,
	tweakBeginSentinel,
	tweakEndSentinel,
	updateTweakComment,
} from "../../utils/tweakComments";

/** Spread a findSourceMatch result into String.slice(start, end) arguments. */
const offsets = (m: { start: number; end: number }): [number, number] => [m.start, m.end];

describe("tweakComments parser/serializer", () => {
	describe("serializeTweakComment", () => {
		it("wraps highlighted text with begin/end markers containing plain-text body", () => {
			const out = serializeTweakComment({
				id: "c_abc",
				highlighted: "evidenziato",
				comment: "il mio commento",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(out).toBe(
				"<!--tweak:begin:c_abc-->evidenziato<!--tweak:end:c_abc @2026-04-05T10:00:00.000Z\nil mio commento-->",
			);
		});

		it("handles comments with quotes, newlines and special characters verbatim", () => {
			const tricky = 'ha "virgolette", a capo\ne simboli < & <!-- <script>';
			const out = serializeTweakComment({
				id: "c_1",
				highlighted: "x",
				comment: tricky,
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			// Body appears verbatim after the timestamp newline.
			expect(out).toContain(`@2026-04-05T10:00:00.000Z\n${tricky}-->`);
		});

		it("escapes the `-->` sequence in the comment body", () => {
			const out = serializeTweakComment({
				id: "c_1",
				highlighted: "x",
				comment: "close-me --> now",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(out).toContain("close-me --&gt; now");
			expect(out).not.toContain("close-me --> now");
		});
	});

	describe("parseTweakComments", () => {
		it("returns empty array when no markers present", () => {
			expect(parseTweakComments("# Title\n\nplain text")).toEqual([]);
		});

		it("extracts a single comment with its highlighted text", () => {
			const src = "Hello <!--tweak:begin:c_1-->world<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nciao-->!";
			const comments = parseTweakComments(src);
			expect(comments).toHaveLength(1);
			expect(comments[0].id).toBe("c_1");
			expect(comments[0].highlighted).toBe("world");
			expect(comments[0].comment).toBe("ciao");
			expect(comments[0].createdAt).toBe("2026-04-05T10:00:00.000Z");
		});

		it("extracts multiple comments preserving order", () => {
			const src =
				"A <!--tweak:begin:c_1-->one<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nfirst--> B " +
				"<!--tweak:begin:c_2-->two<!--tweak:end:c_2 @2026-04-05T10:01:00.000Z\nsecond--> C";
			const comments = parseTweakComments(src);
			expect(comments.map((c) => c.id)).toEqual(["c_1", "c_2"]);
			expect(comments.map((c) => c.comment)).toEqual(["first", "second"]);
		});

		it("ignores malformed markers instead of throwing", () => {
			const src = `text <!--tweak:begin:bad--> no end marker`;
			expect(parseTweakComments(src)).toEqual([]);
		});

		it("unescapes `--&gt;` back to `-->` in the body", () => {
			const src = "<!--tweak:begin:c_1-->x<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nclose-me --&gt; now-->";
			const [parsed] = parseTweakComments(src);
			expect(parsed.comment).toBe("close-me --> now");
		});
	});

	describe("round-trip parse(serialize(x))", () => {
		it("preserves all fields", () => {
			const original: TweakComment = {
				id: "c_xyz",
				highlighted: "la parte evidenziata",
				comment: 'commento con "quotes", newline\ne caratteri <>& e perfino -->',
				createdAt: "2026-04-05T10:00:00.000Z",
			};
			const src = `Prefix ${serializeTweakComment(original)} suffix.`;
			const [parsed] = parseTweakComments(src);
			expect(parsed).toEqual(original);
		});
	});

	describe("insertTweakComment", () => {
		it("replaces the exact highlighted substring with the wrapped version", () => {
			const src = "Una frase con parola evidenziata dentro.";
			const out = insertTweakComment(src, {
				id: "c_1",
				highlighted: "parola evidenziata",
				comment: "nota",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(out).toContain(
				"<!--tweak:begin:c_1-->parola evidenziata<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nnota-->",
			);
			const body = out.slice(CONVENTION_HEADER.length);
			expect(body.startsWith("Una frase con ")).toBe(true);
			expect(body.endsWith(" dentro.")).toBe(true);
		});

		it("adds convention header on first insertion", () => {
			const src = "Plain document.";
			const out = insertTweakComment(src, {
				id: "c_1",
				highlighted: "Plain",
				comment: "x",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(out).toContain(CONVENTION_HEADER);
			expect(out.indexOf(CONVENTION_HEADER)).toBe(0);
		});

		it("does not duplicate convention header on subsequent insertions", () => {
			let src = "First word and second word.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "First",
				comment: "a",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			src = insertTweakComment(src, {
				id: "c_2",
				highlighted: "second",
				comment: "b",
				createdAt: "2026-04-05T10:01:00.000Z",
			});
			const occurrences = src.split(CONVENTION_HEADER).length - 1;
			expect(occurrences).toBe(1);
		});

		it("throws when highlighted text is not found in source", () => {
			expect(() =>
				insertTweakComment("hello", {
					id: "c_1",
					highlighted: "missing",
					comment: "x",
					createdAt: "2026-04-05T10:00:00.000Z",
				}),
			).toThrow();
		});

		it("rejects commenting on already-commented text (no nesting)", () => {
			// Regression: commenting text that already carries a comment used to nest
			// the markers; the lazy parser swallowed the inner one, so it saved to
			// disk but never parsed/rendered again — looked like it "didn't persist".
			let src = "The reason for this Decision is clear.";
			src = insertTweakComment(src, {
				id: "c_outer",
				highlighted: "reason",
				comment: "outer",
				createdAt: "2026-07-15T10:00:00.000Z",
			});
			expect(() =>
				insertTweakComment(src, {
					id: "c_inner",
					highlighted: "reason",
					comment: "inner",
					createdAt: "2026-07-15T10:01:00.000Z",
				}),
			).toThrow(OverlappingCommentError);
			// The file still holds exactly one, parseable comment.
			expect(parseTweakComments(src).map((c) => c.id)).toEqual(["c_outer"]);
		});

		it("rejects a sub-selection inside an existing comment", () => {
			let src = "unique-token appears once here.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "unique-token",
				comment: "a",
				createdAt: "2026-07-15T10:00:00.000Z",
			});
			// "token" only exists inside the already-commented span → must be rejected.
			expect(() =>
				insertTweakComment(src, {
					id: "c_2",
					highlighted: "token",
					comment: "b",
					createdAt: "2026-07-15T10:01:00.000Z",
				}),
			).toThrow(OverlappingCommentError);
		});

		it("allows a second comment on a different, non-overlapping occurrence", () => {
			let src = "alpha and beta and gamma.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "alpha",
				comment: "a",
				createdAt: "2026-07-15T10:00:00.000Z",
			});
			src = insertTweakComment(src, {
				id: "c_2",
				highlighted: "gamma",
				comment: "b",
				createdAt: "2026-07-15T10:01:00.000Z",
			});
			expect(
				parseTweakComments(src)
					.map((c) => c.id)
					.sort(),
			).toEqual(["c_1", "c_2"]);
			// Both render as independent highlight spans.
			const rendered = injectTweakSentinels(src);
			expect(rendered).toContain(tweakBeginSentinel("c_1"));
			expect(rendered).toContain(tweakBeginSentinel("c_2"));
		});

		it("anchors the requested occurrence, not the first (repeated text)", () => {
			// Regression: a word appearing many times used to always anchor to the
			// FIRST occurrence, leaving the user's actual selection unhighlighted.
			const src = "reason A. reason B. reason C.";
			const out = insertTweakComment(
				src,
				{ id: "c_1", highlighted: "reason", comment: "x", createdAt: "2026-07-15T10:00:00.000Z" },
				2, // the 3rd "reason"
			);
			const body = out.slice(CONVENTION_HEADER.length);
			// First two "reason" stay bare; only the 3rd is wrapped.
			expect(body).toBe(
				"reason A. reason B. <!--tweak:begin:c_1-->reason<!--tweak:end:c_1 @2026-07-15T10:00:00.000Z\nx--> C.",
			);
		});

		it("ignores occurrences inside the convention header and comment bodies when counting", () => {
			// The header contains words like "comment"/"text" and bodies hold free
			// text — both are invisible in the DOM, so they must NOT shift ordinals.
			let src = "keep keep keep.";
			// First comment on occurrence 0; its body deliberately contains "keep".
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "keep",
				comment: "keep this in mind",
				createdAt: "2026-07-15T10:00:00.000Z",
			});
			// Now anchor occurrence 2 (the 3rd visible "keep"). Body "keep" and any
			// header words must not throw the count off.
			src = insertTweakComment(
				src,
				{ id: "c_2", highlighted: "keep", comment: "y", createdAt: "2026-07-15T10:01:00.000Z" },
				2,
			);
			const parsed = parseTweakComments(src);
			expect(parsed.map((c) => c.id).sort()).toEqual(["c_1", "c_2"]);
			// c_2 must wrap the LAST "keep", immediately before the period.
			expect(src).toContain("<!--tweak:begin:c_2-->keep<!--tweak:end:c_2 @2026-07-15T10:01:00.000Z\ny-->.");
		});

		it("findSourceMatch returns null when the requested occurrence does not exist", () => {
			expect(findSourceMatch("only one here", "one", 3)).toBeNull();
		});

		it("matches a rendered selection fully inside inline bold (markers stripped by the DOM)", () => {
			// Source has **bold**; the DOM selection drops the asterisks. We wrap the
			// visible inner text so the result renders as `**<span>…</span>**` (bold + highlight).
			const src = "x **bold text** y";
			const out = insertTweakComment(src, {
				id: "c_1",
				highlighted: "bold text",
				comment: "nota",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(out).toContain("**<!--tweak:begin:c_1-->bold text<!--tweak:end:c_1");
			expect(parseTweakComments(out)[0].highlighted).toBe("bold text");
		});

		it("matches a rendered selection that straddles a bold boundary (the real-world case)", () => {
			// Boss's actual failure: selecting "This repo: notes" across the end of **…**.
			const src = "- **This repo:** notes, plans, analysis.";
			const out = insertTweakComment(src, {
				id: "c_1",
				highlighted: "This repo: notes",
				comment: "nota",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			// It no longer throws, and removal restores the byte-identical original.
			expect(removeTweakComment(out, "c_1")).toBe(src);
		});

		it("matches a rendered selection that spans a hard line wrap", () => {
			const src = "alpha beta\ngamma delta";
			const out = insertTweakComment(src, {
				id: "c_1",
				highlighted: "beta gamma",
				comment: "x",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(parseTweakComments(out)[0].highlighted).toBe("beta\ngamma");
		});

		it("removeTweakComment restores the original markdown after a fully-inside insert", () => {
			const src = "x **bold text** y";
			const inserted = insertTweakComment(src, {
				id: "c_1",
				highlighted: "bold text",
				comment: "nota",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(removeTweakComment(inserted, "c_1")).toBe(src);
		});
	});

	describe("findSourceMatch", () => {
		it("returns exact offsets for a verbatim match (fast path)", () => {
			expect(findSourceMatch("hello world", "world")).toEqual({ start: 6, end: 11 });
		});

		it("maps a bold-stripped selection back to the inner visible source slice", () => {
			const src = "x **bold text** y";
			const m = findSourceMatch(src, "bold text");
			expect(m).not.toBeNull();
			expect(src.slice(m!.start, m!.end)).toBe("bold text");
		});

		it("maps italic/code/strike selections back to the inner visible text", () => {
			const src = "a *em* b `code` c ~~gone~~ d";
			expect(src.slice(...offsets(findSourceMatch(src, "em")!))).toBe("em");
			expect(src.slice(...offsets(findSourceMatch(src, "code")!))).toBe("code");
			expect(src.slice(...offsets(findSourceMatch(src, "gone")!))).toBe("gone");
		});

		it("matches across a hard line wrap and collapsed whitespace", () => {
			const src = "alpha beta\ngamma   delta";
			expect(src.slice(...offsets(findSourceMatch(src, "beta gamma delta")!))).toBe("beta\ngamma   delta");
		});

		it("returns null when the text is genuinely absent", () => {
			expect(findSourceMatch("hello world", "absent")).toBeNull();
		});

		it("returns null for an empty/whitespace-only selection", () => {
			expect(findSourceMatch("hello", "   ")).toBeNull();
		});
	});

	describe("removeTweakComment", () => {
		it("removes markers but preserves highlighted text", () => {
			const src = "A <!--tweak:begin:c_1-->kept<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nx--> B";
			const out = removeTweakComment(src, "c_1");
			expect(out).toBe("A kept B");
		});

		it("removes convention header when last comment is removed", () => {
			let src = "Word here.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "Word",
				comment: "x",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			expect(src).toContain(CONVENTION_HEADER);
			src = removeTweakComment(src, "c_1");
			expect(src).not.toContain(CONVENTION_HEADER);
			expect(src).toBe("Word here.");
		});

		it("keeps convention header when other comments remain", () => {
			let src = "Word one and word two.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "one",
				comment: "a",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			src = insertTweakComment(src, {
				id: "c_2",
				highlighted: "two",
				comment: "b",
				createdAt: "2026-04-05T10:01:00.000Z",
			});
			src = removeTweakComment(src, "c_1");
			expect(src).toContain(CONVENTION_HEADER);
			expect(parseTweakComments(src)).toHaveLength(1);
		});

		it("returns source unchanged when id not found", () => {
			const src = "no markers here";
			expect(removeTweakComment(src, "c_missing")).toBe(src);
		});
	});

	describe("updateTweakComment", () => {
		it("updates the comment text while preserving id, highlighted text and createdAt", () => {
			let src = "Hello world.";
			src = insertTweakComment(src, {
				id: "c_1",
				highlighted: "world",
				comment: "original",
				createdAt: "2026-04-05T10:00:00.000Z",
			});
			src = updateTweakComment(src, "c_1", "updated");
			const [parsed] = parseTweakComments(src);
			expect(parsed.comment).toBe("updated");
			expect(parsed.highlighted).toBe("world");
			expect(parsed.id).toBe("c_1");
			expect(parsed.createdAt).toBe("2026-04-05T10:00:00.000Z");
		});
	});

	describe("injectTweakSentinels", () => {
		it("replaces tweak markers with begin/end sentinels keeping the inline text", () => {
			const src = "Hello <!--tweak:begin:c_1-->world<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nnota-->!";
			const out = injectTweakSentinels(src);
			expect(out).toBe(`Hello ${tweakBeginSentinel("c_1")}world${tweakEndSentinel("c_1")}!`);
			expect(out).not.toContain("<!--tweak:");
		});

		it("preserves markdown formatting inline between the sentinels", () => {
			const src = "<!--tweak:begin:c_1-->**bold** and `code`<!--tweak:end:c_1 @2026-04-05T10:00:00.000Z\nx-->";
			const out = injectTweakSentinels(src);
			expect(out).toBe(`${tweakBeginSentinel("c_1")}**bold** and \`code\`${tweakEndSentinel("c_1")}`);
		});

		it("strips the convention header", () => {
			const src = CONVENTION_HEADER + "# Title\n\nBody text.";
			const out = injectTweakSentinels(src);
			expect(out).not.toContain(CONVENTION_HEADER);
			expect(out).toContain("# Title");
		});

		it("is a no-op on plain markdown without markers", () => {
			const src = "# Title\n\nSome **bold** text.";
			expect(injectTweakSentinels(src)).toBe(src);
		});
	});

	describe("ensureConventionHeader", () => {
		it("adds header when missing", () => {
			const out = ensureConventionHeader("body");
			expect(out.startsWith(CONVENTION_HEADER)).toBe(true);
			expect(out).toContain("body");
		});

		it("is idempotent when header already present", () => {
			const first = ensureConventionHeader("body");
			const second = ensureConventionHeader(first);
			expect(second).toBe(first);
		});
	});

	describe("toggleCheckbox", () => {
		const src = [
			"# Plan", // line 0
			"- [ ] First task", // line 1
			"- [x] Second task", // line 2
			"- [~] In progress", // line 3
			"- [ ] Fourth task", // line 4
		].join("\n");

		it("checks an unchecked box by source line", () => {
			const out = toggleCheckbox(src, 1, "x");
			expect(out).toContain("- [x] First task");
		});

		it("unchecks a checked box by source line", () => {
			const out = toggleCheckbox(src, 2, " ");
			expect(out).toContain("- [ ] Second task");
		});

		it("sets tilde on an unchecked box", () => {
			const out = toggleCheckbox(src, 4, "~");
			expect(out).toContain("- [~] Fourth task");
		});

		it("unchecks a tilde box", () => {
			const out = toggleCheckbox(src, 3, " ");
			expect(out).toContain("- [ ] In progress");
		});

		it("leaves other checkboxes untouched", () => {
			const out = toggleCheckbox(src, 1, "x");
			expect(out).toContain("- [x] Second task");
			expect(out).toContain("- [~] In progress");
			expect(out).toContain("- [ ] Fourth task");
		});

		it("handles nested indentation", () => {
			const nested = "- [x] Top\n  - [ ] Nested\n  - [x] Nested done";
			const out = toggleCheckbox(nested, 1, "x");
			expect(out).toContain("  - [x] Nested");
			expect(out).toContain("- [x] Top"); // unchanged
		});

		it("handles * and + list markers", () => {
			const mixed = "* [ ] Star\n+ [ ] Plus\n- [ ] Dash";
			const out = toggleCheckbox(mixed, 1, "x");
			expect(out).toContain("+ [x] Plus");
			expect(out).toContain("* [ ] Star"); // unchanged
		});

		it("returns source unchanged for non-checkbox line", () => {
			expect(toggleCheckbox(src, 0, "x")).toBe(src); // line 0 is "# Plan"
		});

		it("returns source unchanged for out-of-range line", () => {
			expect(toggleCheckbox(src, 99, "x")).toBe(src);
		});
	});
});
