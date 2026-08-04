/**
 * Incremental sentence splitter for streaming speech.
 *
 * The agent's reply arrives as deltas; speech has to start before the reply is
 * finished or every answer begins with a long silence. `feed()` returns whole
 * sentences as they complete, `flush()` the remainder at the end of a turn.
 *
 * Sanitizing matters more here than it looks: the phonemizer has no espeak
 * fallback, so anything outside its dictionary — `conversationStore`,
 * `src-tauri`, a code block — is spelled out letter by letter. Stripping code
 * and markup is what keeps replies listenable.
 */

/** Strip markdown and code so what reaches the synthesizer is prose. */
export function sanitizeForSpeech(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " Code omitted. ") // fenced code blocks
		.replace(/```+/g, " ") // stray or unclosed fences
		.replace(/`([^`]*)`/g, "$1") // inline code
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their label
		.replace(/^#{1,6}\s+/gm, "") // headings
		.replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
		.replace(/(\*|_)(.*?)\1/g, "$2") // italics
		.replace(/~~(.*?)~~/g, "$1") // strikethrough
		.replace(/^\s*[-*+]\s+/gm, "") // bullets
		.replace(/^\s*\d+\.\s+/gm, "") // numbered lists
		.replace(/^\s*>\s?/gm, "") // blockquotes
		.replace(/\|/g, ", ") // table pipes
		.replace(/(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F})/gu, "") // emoji
		.replace(/\s+/g, " ")
		.trim();
}

/** Sentence-ending punctuation, or a blank line. */
const BOUNDARY = /[.!?…][)"'’\]]*\s|\n{2,}/g;

export class SentenceChunker {
	private buffer = "";
	private readonly minChars: number;

	/**
	 * @param minChars Fragments shorter than this are merged into the next
	 * sentence instead of spoken alone — "Sure." on its own sounds clipped, and
	 * each utterance costs a separate inference pass.
	 */
	constructor({ minChars = 20 }: { minChars?: number } = {}) {
		this.minChars = minChars;
	}

	/** Feed a streamed delta; returns any sentences it completed. */
	feed(delta: string): string[] {
		this.buffer += delta;
		const sentences: string[] = [];
		let index = this.findSplitIndex();
		while (index !== -1) {
			const raw = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index);
			const clean = sanitizeForSpeech(raw);
			if (clean) sentences.push(clean);
			index = this.findSplitIndex();
		}
		return sentences;
	}

	private findSplitIndex(): number {
		BOUNDARY.lastIndex = 0;
		let match = BOUNDARY.exec(this.buffer);
		while (match !== null) {
			const end = match.index + match[0].length;
			// Never split inside an open code fence — half a fence sanitizes
			// into nonsense, and the closing half would be spoken as prose.
			const fences = (this.buffer.slice(0, end).match(/```/g) || []).length;
			if (fences % 2 === 0 && end >= this.minChars) return end;
			match = BOUNDARY.exec(this.buffer);
		}
		return -1;
	}

	/** Speak whatever is left at the end of a turn. */
	flush(): string | null {
		const clean = sanitizeForSpeech(this.buffer);
		this.buffer = "";
		return clean || null;
	}

	/** Drop buffered text — used on barge-in and stream errors. */
	reset(): void {
		this.buffer = "";
	}
}
