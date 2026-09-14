/**
 * Splitting a growing markdown answer into a prefix that is safe to render
 * once and keep, and a tail that is re-parsed on every tick.
 *
 * A streaming answer is re-rendered many times, and rendering it re-parses,
 * re-sanitizes and re-inserts the WHOLE document each time, so the cost of an
 * answer is quadratic in its length. The fix is to stop re-parsing the part
 * that can no longer change — but markdown does not compose at arbitrary
 * boundaries. A cut inside a fence leaves two unterminated code blocks; a cut
 * between the items of a loose list renders two adjacent lists; a cut between
 * a reference link and its definition renders literal brackets.
 *
 * So the rule everywhere below is one-directional: **when in doubt, do not
 * commit**. Refusing a safe cut only costs speed — the text stays in the tail
 * and behaves exactly as it does today. Taking an unsafe cut corrupts what the
 * reader sees. Every guard here is written to fail toward the tail.
 */

/** A parse unit: source text plus where it sits in the whole document. */
export interface MarkdownSegment {
	/** Source text of this segment, including its trailing blank lines. */
	text: string;
	/**
	 * Absolute 0-based index of this segment's first line in the full source.
	 * Callers add it to any line number derived from `text` alone — that is
	 * what keeps checkbox `data-source-line` values pointing at the real file.
	 */
	lineOffset: number;
}

export interface StreamSplit {
	/** Segments proven complete. Their text never changes as the source grows. */
	committed: MarkdownSegment[];
	/** Everything after the last commit. The only part a tick must re-parse. */
	tail: MarkdownSegment;
	/**
	 * The source prefix the committed segments cover. Kept so a resume can
	 * prove in one comparison that the new source really extends the old one.
	 */
	prefix: string;
	/**
	 * `prefix` plus the first line after it — the line whose shape licensed the
	 * last cut. A replacement that keeps the prefix but rewrites that line
	 * (`After.` becoming `- two`, turning two blocks into one loose list) makes
	 * the cut wrong retroactively, so the resume test is this, not `prefix`.
	 */
	guard: string;
}

/** Matches the fence detection ContentRenderer's own line walkers use. Keep
 *  them identical: a splitter that disagrees with the renderer about where a
 *  fence starts would cut exactly where the renderer does not expect it. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const BLANK_RE = /^\s*$/;
/** A list marker needs its trailing space, so a bare "-" at the end of a
 *  half-received line is not yet a list. That is why an incomplete final line
 *  can never decide a boundary. */
const LIST_RE = /^(?:[-*+]\s|\d{1,9}[.)]\s)/;
const HTML_TAG_LINE_RE = /^<\/?[a-zA-Z]/;
const HTML_OPEN_RE = /^<([a-zA-Z][\w-]*)(?=[\s/>])/;
const HTML_CLOSE_RE = /^<\/([a-zA-Z][\w-]*)/;
const HTML_SELF_CLOSE_RE = /^<[a-zA-Z][\w-]*(?:\s[^>]*)?\/>/;
/** Elements with no closing tag. Counting one as an unclosed open would make
 *  every later candidate fail, and the tail would grow without bound. */
const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
/** A reference-link definition. One of these resolves usages ANYWHERE in the
 *  document, including in text committed long before it arrived — and the
 *  shortcut `[label]` form means any bracket may be a usage. So a document that
 *  carries a definition is not splittable at all; see `hasReferenceDefinition`. */
const REF_DEF_RE = /^ {0,3}\[[^\]]+\]:\s/;
const REF_DEF_ANYWHERE_RE = /^ {0,3}\[[^\]]+\]:\s/m;
const TWEAK_BEGIN = "<!--tweak:begin:";
const TWEAK_END = "<!--tweak:end:";
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

interface Line {
	text: string;
	/** Absolute index of this line's first character in the full source. */
	start: number;
}

function scanLines(source: string, from: number): Line[] {
	const lines: Line[] = [];
	let start = from;
	for (let i = from; i < source.length; i++) {
		if (source[i] === "\n") {
			lines.push({ text: source.slice(start, i), start });
			start = i + 1;
		}
	}
	lines.push({ text: source.slice(start), start });
	return lines;
}

/**
 * Advance the fence state over one line. `open` is the marker that opened the
 * current fence, or null outside one.
 *
 * A blind toggle is wrong: CommonMark closes a fence only with the same
 * character, repeated at least as many times, and carrying no info string.
 * ```` ```` ```` is not closed by ``` ``` ```, and a toggle would hand the code
 * that follows to the renderer as prose.
 */
function stepFence(open: string | null, line: string): string | null {
	const m = FENCE_RE.exec(line);
	if (!m) return open;
	const marker = m[1];
	if (open === null) return marker;
	const closes = marker[0] === open[0] && marker.length >= open.length && line.trim() === marker;
	return closes ? null : open;
}

/**
 * Does the document define a reference link anywhere outside a fence?
 *
 * The cheap test runs first because the answer is almost always no; only then
 * is it worth walking the lines to discard definitions that are really just
 * code inside a fence.
 */
function hasReferenceDefinition(source: string): boolean {
	if (!REF_DEF_ANYWHERE_RE.test(source)) return false;
	let fence: string | null = null;
	for (const line of source.split("\n")) {
		const next = stepFence(fence, line);
		if (next !== fence) {
			fence = next;
			continue;
		}
		if (fence === null && REF_DEF_RE.test(line)) return true;
	}
	return false;
}

function countOccurrences(haystack: string, needle: string): number {
	let n = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		n++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return n;
}

/**
 * Can the following block start a new segment? Only a block that begins hard
 * against column 0 and cannot be a continuation of what came before.
 *
 * A blank line alone proves nothing: a loose list, a list item's indented
 * paragraph and a blockquote all survive one. Each rejection below is a shape
 * a blank line does NOT terminate.
 */
function startsFreshBlock(line: string): boolean {
	if (!/^\S/.test(line)) return false; // indented → continuation
	if (LIST_RE.test(line)) return false; // another item of the same list
	if (line.startsWith(">")) return false; // same blockquote
	if (line.startsWith("|")) return false; // same table
	// A real tag may be the open half of an HTML block; a comment is closed.
	if (HTML_TAG_LINE_RE.test(line)) return false;
	return true;
}

/**
 * Does this candidate segment render the same alone as it does in place?
 *
 * What reaches across a segment boundary here is raw HTML: a tag opened in this
 * segment and closed in a later one would be closed by the sanitizer at the
 * segment's edge, so the rest of the document escapes the wrapper. Reference
 * links reach across too, but no boundary can make them safe — a definition
 * resolves usages document-wide — so they are handled once, for the whole
 * document, in `hasReferenceDefinition`.
 */
function rendersStandalone(text: string): boolean {
	const open = new Map<string, number>();
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const next = stepFence(fence, line);
		if (next !== fence) {
			fence = next;
			continue;
		}
		if (fence !== null) continue;
		const opened = HTML_OPEN_RE.exec(line);
		// A void element and a self-closing tag never wait for a closing tag, so
		// neither can straddle a boundary.
		if (opened && !VOID_TAGS.has(opened[1].toLowerCase()) && !HTML_SELF_CLOSE_RE.test(line)) {
			const name = opened[1].toLowerCase();
			open.set(name, (open.get(name) ?? 0) + 1);
		}
		const closed = HTML_CLOSE_RE.exec(line);
		if (closed) {
			const name = closed[1].toLowerCase();
			const depth = (open.get(name) ?? 0) - 1;
			// A close with no open in this segment is just as broken as the
			// reverse: its opening tag was committed in an earlier segment.
			if (depth < 0) return false;
			open.set(name, depth);
		}
	}
	for (const depth of open.values()) if (depth > 0) return false;
	return true;
}

/**
 * Advance the split over `source`.
 *
 * Pass the previous result as `prev` to resume: only the tail is re-scanned,
 * which is what keeps a tick's cost independent of the answer's length. If
 * `source` does not extend the previous source — a conversation switch replaces
 * the text rather than appending to it — the scan restarts from scratch, so a
 * caller can always pass whatever it has.
 */
export function splitStream(source: string, prev?: StreamSplit): StreamSplit {
	// One definition anywhere makes every earlier bracket a possible link, so
	// the whole document has to be parsed together. Costs the optimization for
	// that answer; costs nothing else.
	if (hasReferenceDefinition(source)) {
		return { committed: [], tail: { text: source, lineOffset: 0 }, prefix: "", guard: "" };
	}

	const resume = prev && source.startsWith(prev.guard) ? prev : undefined;
	const from = resume ? resume.prefix.length : 0;
	const firstLine = resume ? resume.tail.lineOffset : 0;

	const lines = scanLines(source, from);
	const endsOpen = !source.endsWith("\n");
	const segments: MarkdownSegment[] = [];
	let segStart = 0; // index into `lines`
	let guard = resume ? resume.guard : "";
	let fence: string | null = null;
	let openTweaks = 0;
	let openComments = 0;

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i].text;
		const nextFence = stepFence(fence, text);
		if (nextFence !== fence) {
			fence = nextFence;
			continue;
		}
		if (fence !== null) continue;
		// Both counters clamp at zero: a stray end must not buy a later begin the
		// right to be cut in half.
		openComments = Math.max(
			0,
			openComments + countOccurrences(text, COMMENT_OPEN) - countOccurrences(text, COMMENT_CLOSE),
		);
		if (openComments > 0) continue;
		openTweaks = Math.max(0, openTweaks + countOccurrences(text, TWEAK_BEGIN) - countOccurrences(text, TWEAK_END));
		if (openTweaks > 0) continue;
		if (!BLANK_RE.test(text)) continue;

		let j = i + 1;
		while (j < lines.length && BLANK_RE.test(lines[j].text)) j++;
		if (j >= lines.length) continue; // the next block has not started yet
		// The last line is still being received while the stream is open, so it
		// cannot be trusted to decide anything: "-" becomes "- item".
		if (j === lines.length - 1 && endsOpen) continue;
		if (!startsFreshBlock(lines[j].text)) continue;

		const candidate = source.slice(lines[segStart].start, lines[j].start);
		if (!rendersStandalone(candidate)) continue;

		segments.push({ text: candidate, lineOffset: firstLine + segStart });
		segStart = j;
		// `lines[j]` is always a complete line — the rule above rejects a cut
		// decided on the growing edge — so it is safe to freeze into the guard.
		guard = source.slice(0, lines[j].start + lines[j].text.length + 1);
	}

	const consumed = lines[segStart].start;
	return {
		committed: resume ? [...resume.committed, ...segments] : segments,
		tail: { text: source.slice(consumed), lineOffset: firstLine + segStart },
		prefix: source.slice(0, consumed),
		guard,
	};
}
