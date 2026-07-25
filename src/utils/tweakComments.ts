/**
 * Inline review comments for markdown files.
 *
 * Comments are stored directly inside the .md source as HTML comments,
 * which are invisible to any markdown renderer but readable by humans and LLMs:
 *
 *     prefix <!--tweak:begin:ID-->highlighted text<!--tweak:end:ID @<ISO-TIMESTAMP>
 *     comment body, free text, may span multiple lines
 *     --> suffix
 *
 * The body is plain text. The only forbidden sequence is `-->` (which would
 * close the enclosing HTML comment prematurely); it is escaped to `--&gt;`
 * on write and restored on read. No other escaping is performed — quotes,
 * newlines, unicode, `<`, `&` are all kept verbatim.
 *
 * The first time a comment is added to a file, a convention header is prepended
 * so that any LLM reading the file understands the format without external context.
 */

export interface TweakComment {
	id: string;
	highlighted: string;
	comment: string;
	createdAt: string;
}

export const CONVENTION_HEADER =
	"<!-- tweak-comments v1: inline review comments.\n" +
	"     Format: [tweak:begin:ID]highlighted text[tweak:end:ID @ISO-TIMESTAMP\n" +
	"     comment body (free text, may span multiple lines)\n" +
	"     ] — where [ ] are the HTML comment delimiters <!-- -->.\n" +
	"     The only escape is '-->' → '--&gt;' inside the comment body.\n" +
	"     Read each comment, apply the feedback to the highlighted text,\n" +
	"     then remove the tweak markers. -->\n\n";

// Matches a full tweak comment span: begin marker, highlighted content,
// end marker with timestamp + body. Lazy matching is safe because the body
// cannot contain `-->` (escaped at write time).
const FULL_RE = /<!--tweak:begin:([A-Za-z0-9_-]+)-->([\s\S]*?)<!--tweak:end:\1 @(\S+)\s([\s\S]*?)-->/g;

/** Escape the only sequence that would break the enclosing HTML comment. */
function escapeBody(body: string): string {
	return body.replace(/-->/g, "--&gt;");
}

/** Reverse escapeBody. */
function unescapeBody(body: string): string {
	return body.replace(/--&gt;/g, "-->");
}

/** Serialize a comment into its inline marker form (does not insert into source). */
export function serializeTweakComment(c: TweakComment): string {
	return `<!--tweak:begin:${c.id}-->${c.highlighted}<!--tweak:end:${c.id} @${c.createdAt}\n${escapeBody(c.comment)}-->`;
}

/** Parse all tweak comments from a markdown source, in document order. */
export function parseTweakComments(source: string): TweakComment[] {
	const results: TweakComment[] = [];
	FULL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FULL_RE.exec(source)) !== null) {
		const [, id, highlighted, createdAt, body] = match;
		results.push({
			id,
			highlighted,
			comment: unescapeBody(body),
			createdAt,
		});
	}
	return results;
}

/** Prepend the convention header if not already present. */
export function ensureConventionHeader(source: string): string {
	if (source.startsWith(CONVENTION_HEADER)) return source;
	// Also treat a stripped (whitespace-trimmed) match as present to be resilient
	// to trailing-newline normalization by editors.
	if (source.includes(CONVENTION_HEADER.trimEnd())) return source;
	return CONVENTION_HEADER + source;
}

/** Remove the convention header if present (used when last comment is removed). */
function removeConventionHeader(source: string): string {
	if (source.startsWith(CONVENTION_HEADER)) {
		return source.slice(CONVENTION_HEADER.length);
	}
	const trimmed = CONVENTION_HEADER.trimEnd();
	const idx = source.indexOf(trimmed);
	if (idx === 0) {
		let end = trimmed.length;
		while (end < source.length && (source[end] === "\n" || source[end] === "\r")) end++;
		return source.slice(end);
	}
	return source;
}

// Inline emphasis/code/strikethrough markers that markdown renders away, so they
// are absent from a DOM text selection. We strip them (and collapse whitespace)
// when matching a rendered selection back to the raw source.
// DEFERRED (2026-06-01) — link syntax `[text](url)` is not normalized: the
// rendered selection shows "text" while the source keeps "(url)", so a selection
// spanning a link still fails to match. Needs a tokenizer-aware pass; rare enough
// to defer until a real case shows up.
const INLINE_MARKERS_RE = /[*_`~]/g;

/** Normalize a rendered selection for matching: drop inline markers, collapse whitespace. */
export function normalizeForMatch(text: string): string {
	return text.replace(INLINE_MARKERS_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Build a boolean mask over `source`, `false` for every character that is NOT
 * visible in the rendered DOM: the convention header and every tweak marker's
 * syntax (begin marker, and the end marker including its comment body). The
 * highlighted text BETWEEN a begin/end pair stays visible. Handles nested
 * markers because each marker is masked independently.
 *
 * This makes source-side occurrence counting align with the rendered DOM, which
 * is where the caller's `occurrenceIndex` is measured — the header/markers/bodies
 * are absent from the DOM, so they must not shift ordinals.
 */
function buildVisibilityMask(source: string): boolean[] {
	const visible = new Array<boolean>(source.length).fill(true);
	const hide = (start: number, end: number) => {
		for (let i = start; i < end && i < source.length; i++) visible[i] = false;
	};
	// Convention header (exact or trailing-trimmed).
	if (source.startsWith(CONVENTION_HEADER)) {
		hide(0, CONVENTION_HEADER.length);
	} else {
		const trimmed = CONVENTION_HEADER.trimEnd();
		if (source.startsWith(trimmed)) hide(0, trimmed.length);
	}
	// Marker syntax — begin markers and end markers (bodies included).
	const beginRe = /<!--tweak:begin:[A-Za-z0-9_-]+-->/g;
	const endRe = /<!--tweak:end:[A-Za-z0-9_-]+ @\S+\s[\s\S]*?-->/g;
	for (const re of [beginRe, endRe]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) hide(m.index, m.index + m[0].length);
	}
	return visible;
}

/**
 * Build a marker-stripped, whitespace-collapsed view of `source` alongside a map
 * from each normalized-string index to its originating source offset. This lets a
 * match found in the normalized view be translated back to a slice of the raw source.
 * Characters hidden by `buildVisibilityMask` (header, marker syntax, comment bodies)
 * are skipped so the normalized view matches the rendered DOM text.
 */
function buildNormalizedIndex(source: string): { normalized: string; map: number[] } {
	const chars: string[] = [];
	const map: number[] = [];
	const visible = buildVisibilityMask(source);
	let prevWasSpace = false;
	for (let i = 0; i < source.length; i++) {
		if (!visible[i]) continue; // header / marker syntax / body — not in the DOM
		const ch = source[i];
		if (ch === "*" || ch === "_" || ch === "`" || ch === "~") continue; // invisible inline marker
		if (/\s/.test(ch)) {
			if (prevWasSpace) continue; // collapse runs of whitespace to one space
			chars.push(" ");
			map.push(i);
			prevWasSpace = true;
			continue;
		}
		chars.push(ch);
		map.push(i);
		prevWasSpace = false;
	}
	return { normalized: chars.join(""), map };
}

/** Index of the `n`-th (0-based) occurrence of `needle` in `hay`, or -1. */
function nthIndexOf(hay: string, needle: string, n: number): number {
	let idx = -1;
	for (let k = 0; k <= n; k++) {
		idx = hay.indexOf(needle, idx + 1);
		if (idx === -1) return -1;
	}
	return idx;
}

/**
 * Locate `selection` (text taken from the rendered DOM) within the raw markdown
 * `source`, returning the source offsets to wrap. Matching is done against a
 * normalized view that ignores inline markdown formatting and whitespace
 * differences (line wraps, `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`)
 * and skips invisible regions (convention header, marker syntax, comment bodies).
 *
 * `occurrenceIndex` selects WHICH occurrence to anchor when the selected text
 * appears multiple times in the document — it is the 0-based ordinal of the
 * user's actual selection among identical rendered occurrences (measured in the
 * DOM by the caller). Without it, a repeated word ("reason" ×18) would always
 * anchor to the first occurrence, leaving the user's real selection unhighlighted.
 * Returns null when the requested occurrence cannot be located.
 */
export function findSourceMatch(
	source: string,
	selection: string,
	occurrenceIndex = 0,
): { start: number; end: number } | null {
	const normSel = normalizeForMatch(selection);
	if (!normSel) return null;
	const { normalized, map } = buildNormalizedIndex(source);
	const nIdx = nthIndexOf(normalized, normSel, occurrenceIndex);
	if (nIdx === -1) return null;
	// Map the normalized [start, last] back to raw-source offsets. The selection is
	// trimmed, so its last normalized char is non-whitespace and maps cleanly.
	const start = map[nIdx];
	const end = map[nIdx + normSel.length - 1] + 1;
	return { start, end };
}

/** Source offsets [start, end) of every existing tweak-comment marker span. */
function existingCommentSpans(source: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	FULL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FULL_RE.exec(source)) !== null) {
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

/**
 * Thrown by `insertTweakComment` when the selection overlaps an existing
 * comment. Nesting one `<!--tweak-->` span inside another is unrepresentable:
 * the lazy parser would swallow the inner comment into the outer's highlighted
 * text, so it saves to disk but never parses or renders again (looks like it
 * "didn't persist"). Callers surface this as a distinct, actionable message.
 */
export class OverlappingCommentError extends Error {}

/**
 * Insert a tweak comment into the source by wrapping the source span that the
 * `highlighted` selection corresponds to with begin/end markers. The wrapped
 * span uses the RAW source text (markers included) so the rendered output and
 * round-trip removal stay correct. Throws if the text cannot be located, or an
 * `OverlappingCommentError` if it overlaps an existing comment (nesting is not
 * supported — comment on plain text, or edit the existing comment instead).
 */
export function insertTweakComment(source: string, comment: TweakComment, occurrenceIndex = 0): string {
	const match = findSourceMatch(source, comment.highlighted, occurrenceIndex);
	if (!match) {
		throw new Error(
			`insertTweakComment: highlighted text not found in source: "${comment.highlighted.slice(0, 40)}..."`,
		);
	}
	// Reject a span that intersects an existing comment — nesting corrupts both.
	const overlaps = existingCommentSpans(source).some((sp) => match.start < sp.end && sp.start < match.end);
	if (overlaps) {
		throw new OverlappingCommentError(
			`insertTweakComment: selection overlaps an existing comment: "${comment.highlighted.slice(0, 40)}..."`,
		);
	}
	const sourceSlice = source.slice(match.start, match.end);
	const wrapped = serializeTweakComment({ ...comment, highlighted: sourceSlice });
	const replaced = source.slice(0, match.start) + wrapped + source.slice(match.end);
	return ensureConventionHeader(replaced);
}

/** Remove a comment by id, keeping the highlighted text in place. */
export function removeTweakComment(source: string, id: string): string {
	const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`<!--tweak:begin:${escapedId}-->([\\s\\S]*?)<!--tweak:end:${escapedId} @\\S+\\s[\\s\\S]*?-->`,
		"g",
	);
	let changed = false;
	const out = source.replace(re, (_, highlighted) => {
		changed = true;
		return highlighted;
	});
	if (!changed) return source;
	if (parseTweakComments(out).length === 0) {
		return removeConventionHeader(out);
	}
	return out;
}

/** Update the comment text of an existing tweak comment, preserving its id and highlighted text. */
export function updateTweakComment(source: string, id: string, newComment: string): string {
	const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`<!--tweak:begin:${escapedId}-->([\\s\\S]*?)<!--tweak:end:${escapedId} @(\\S+)\\s[\\s\\S]*?-->`,
		"g",
	);
	return source.replace(re, (_, highlighted, createdAt) =>
		serializeTweakComment({ id, highlighted, comment: newComment, createdAt }),
	);
}

// Private-use Unicode delimiters used to mark a highlight's begin/end boundaries
// in the source BEFORE markdown parsing. They are plain text to `marked` (they do
// not affect emphasis flanking) and survive DOMPurify, so after rendering they can
// be located in the DOM and replaced with `<span class="tweak-highlight">` wrappers.
// Rendering the highlight via the DOM (instead of injecting spans into the source)
// keeps inline formatting intact even when a selection straddles a `**bold**` edge.
const SENTINEL_BEGIN = "\uE000";
const SENTINEL_END = "\uE001";

/** Begin delimiter for a highlight, e.g. `<id>`. */
export function tweakBeginSentinel(id: string): string {
	return `${SENTINEL_BEGIN}${id}${SENTINEL_BEGIN}`;
}

/** End delimiter for a highlight, e.g. `<id>`. */
export function tweakEndSentinel(id: string): string {
	return `${SENTINEL_END}${id}${SENTINEL_END}`;
}

/**
 * Pre-process markdown source before passing to `marked`: strips the convention
 * header and replaces each tweak marker pair with begin/end sentinel delimiters,
 * leaving the highlighted text (with its markdown formatting) inline so `marked`
 * renders it normally. The sentinels are turned into highlight spans afterwards by
 * `applyTweakDomHighlights` operating on the rendered DOM.
 */
export function injectTweakSentinels(source: string): string {
	let out = source.startsWith(CONVENTION_HEADER) ? source.slice(CONVENTION_HEADER.length) : source;
	FULL_RE.lastIndex = 0;
	out = out.replace(FULL_RE, (_, id, highlighted) => `${tweakBeginSentinel(id)}${highlighted}${tweakEndSentinel(id)}`);
	return out;
}

/** Generate a unique id for a new comment (short, URL-safe). */
export function generateTweakCommentId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	const ts = Date.now().toString(36);
	return `c_${ts}${rand}`;
}

// ---- GFM Task-List Checkbox Toggle ----

/**
 * Set the checkbox on the given source line to the specified mark.
 * `sourceLine` is the 0-based line number in the raw markdown source,
 * injected as `data-source-line` by the ContentRenderer preprocessor.
 * `mark` is one of: `" "` (unchecked), `"x"` (checked), `"~"` (in-progress).
 */
export function toggleCheckbox(source: string, sourceLine: number, mark: " " | "x" | "~"): string {
	const lines = source.split("\n");
	if (sourceLine < 0 || sourceLine >= lines.length) return source;
	const line = lines[sourceLine];
	const m = /^(\s*[-*+]\s+)\[([ xX~])\]/.exec(line);
	if (!m) return source;
	lines[sourceLine] = `${m[1]}[${mark}]${line.slice(m[0].length)}`;
	return lines.join("\n");
}
