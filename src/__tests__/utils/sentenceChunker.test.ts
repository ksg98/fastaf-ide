import { describe, expect, it } from "vitest";
import { SentenceChunker, sanitizeForSpeech } from "../../utils/sentenceChunker";

describe("sanitizeForSpeech", () => {
	it("replaces fenced code blocks rather than spelling them out", () => {
		const text = "Try this:\n```ts\nconst x = conversationStore.sendMessage();\n```\nThat works.";
		const clean = sanitizeForSpeech(text);
		expect(clean).toContain("Code omitted.");
		expect(clean).not.toContain("conversationStore");
		expect(clean).not.toContain("```");
	});

	it("unwraps inline code, links and emphasis to their readable text", () => {
		expect(sanitizeForSpeech("Call `run()` now")).toBe("Call run() now");
		expect(sanitizeForSpeech("See [the docs](https://example.com/x)")).toBe("See the docs");
		expect(sanitizeForSpeech("**really** _quite_ ~~not~~ fine")).toBe("really quite not fine");
	});

	it("strips list, heading and quote markers", () => {
		expect(sanitizeForSpeech("## Results")).toBe("Results");
		expect(sanitizeForSpeech("- one\n- two")).toBe("one two");
		expect(sanitizeForSpeech("1. first\n2. second")).toBe("first second");
		expect(sanitizeForSpeech("> quoted")).toBe("quoted");
	});

	it("drops emoji, which have no pronunciation", () => {
		expect(sanitizeForSpeech("Done ✅ shipped 🚀")).toBe("Done shipped");
	});

	it("collapses whitespace and returns empty for markup-only input", () => {
		expect(sanitizeForSpeech("a\n\n  b\t c")).toBe("a b c");
		expect(sanitizeForSpeech("   \n\n  ")).toBe("");
		expect(sanitizeForSpeech("###")).toBe("###");
	});
});

describe("SentenceChunker", () => {
	it("emits nothing until a sentence actually completes", () => {
		const chunker = new SentenceChunker();
		expect(chunker.feed("I am still")).toEqual([]);
		expect(chunker.feed(" thinking about")).toEqual([]);
		expect(chunker.feed(" the answer. ")).toEqual(["I am still thinking about the answer."]);
	});

	it("splits several sentences arriving in one delta", () => {
		const chunker = new SentenceChunker();
		const out = chunker.feed("The build finished without errors. Every test in the suite is green. ");
		expect(out).toEqual(["The build finished without errors.", "Every test in the suite is green."]);
	});

	it("merges a run of short sentences instead of emitting each one", () => {
		const chunker = new SentenceChunker();
		// Each is under minChars alone, so nothing is spoken yet...
		expect(chunker.feed("Yes. No. Maybe. ")).toEqual([]);
		// ...and once the run clears minChars it goes out as one utterance
		// rather than four clipped ones.
		expect(chunker.feed("That is all I know. ")).toEqual(["Yes. No. Maybe. That is all I know."]);
	});

	it("keeps a short fragment back rather than speaking it alone", () => {
		const chunker = new SentenceChunker();
		// "Sure." is under minChars, so it waits for the following sentence.
		expect(chunker.feed("Sure. ")).toEqual([]);
		expect(chunker.feed("Here is what I changed in the file. ")).toEqual(["Sure. Here is what I changed in the file."]);
	});

	it("does not split inside an unclosed code fence", () => {
		const chunker = new SentenceChunker();
		// The '.' inside the fence must not end a sentence mid-block.
		expect(chunker.feed("Run it:\n```\nnpm run build. now\n")).toEqual([]);
		const out = chunker.feed("```\nAnd it should pass cleanly. ");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("Code omitted.");
		expect(out[0]).not.toContain("npm run build");
	});

	it("treats a blank line as a boundary", () => {
		const chunker = new SentenceChunker();
		expect(chunker.feed("First paragraph here\n\n")).toEqual(["First paragraph here"]);
	});

	it("flush returns the trailing partial sentence and empties the buffer", () => {
		const chunker = new SentenceChunker();
		chunker.feed("A complete thought. And a trailing one");
		expect(chunker.flush()).toBe("And a trailing one");
		expect(chunker.flush()).toBeNull();
	});

	it("flush returns null when only markup is left", () => {
		const chunker = new SentenceChunker();
		chunker.feed("```");
		expect(chunker.flush()).toBeNull();
	});

	it("reset drops buffered text so a cancelled turn is not spoken later", () => {
		const chunker = new SentenceChunker();
		chunker.feed("Half a sentence that the user interrupted");
		chunker.reset();
		expect(chunker.flush()).toBeNull();
		// And the next turn starts clean.
		expect(chunker.feed("A brand new sentence entirely. ")).toEqual(["A brand new sentence entirely."]);
	});

	it("handles a sentence split across many single-character deltas", () => {
		const chunker = new SentenceChunker();
		const text = "Streaming one character at a time still works. ";
		const emitted: string[] = [];
		for (const ch of text) emitted.push(...chunker.feed(ch));
		expect(emitted).toEqual(["Streaming one character at a time still works."]);
	});

	it("carries punctuation variants and trailing quotes", () => {
		const chunker = new SentenceChunker();
		expect(chunker.feed('He said "that is the whole story." ')).toEqual(['He said "that is the whole story."']);
		expect(chunker.feed("Is that really everything here? ")).toEqual(["Is that really everything here?"]);
	});
});
