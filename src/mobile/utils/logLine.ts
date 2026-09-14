/**
 * Types and utilities for rendering ANSI-attributed terminal log lines.
 * Matches the Rust LogLine/LogSpan/LogColor serialization format.
 */

// --- Types ---

export interface LogColor {
	idx?: number;
	rgb?: [number, number, number];
}

export interface LogSpan {
	text: string;
	fg?: LogColor;
	bg?: LogColor;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
}

export interface LogLine {
	spans: LogSpan[];
	cols?: number;
}

// --- ANSI color mapping ---

/**
 * Standard ANSI 16-color palette mapped to CSS variables.
 * These variables should be defined in the app's theme and match the terminal palette.
 */
const ANSI_16_VARS: readonly string[] = [
	"var(--ansi-black)",
	"var(--ansi-red)",
	"var(--ansi-green)",
	"var(--ansi-yellow)",
	"var(--ansi-blue)",
	"var(--ansi-magenta)",
	"var(--ansi-cyan)",
	"var(--ansi-white)",
	"var(--ansi-bright-black)",
	"var(--ansi-bright-red)",
	"var(--ansi-bright-green)",
	"var(--ansi-bright-yellow)",
	"var(--ansi-bright-blue)",
	"var(--ansi-bright-magenta)",
	"var(--ansi-bright-cyan)",
	"var(--ansi-bright-white)",
];

/** Convert ANSI 256-color index (16-231) from the 6x6x6 color cube to hex. */
function ansi256CubeToHex(idx: number): string {
	const i = idx - 16;
	const r = Math.floor(i / 36);
	const g = Math.floor((i % 36) / 6);
	const b = i % 6;
	const toVal = (c: number) => (c === 0 ? 0 : 55 + c * 40);
	return `#${toVal(r).toString(16).padStart(2, "0")}${toVal(g).toString(16).padStart(2, "0")}${toVal(b).toString(16).padStart(2, "0")}`;
}

/** Convert ANSI 256-color grayscale index (232-255) to hex. */
function ansi256GrayToHex(idx: number): string {
	const level = 8 + (idx - 232) * 10;
	const hex = level.toString(16).padStart(2, "0");
	return `#${hex}${hex}${hex}`;
}

/** Convert a LogColor to a CSS color string, or undefined for default. */
export function logColorToCss(color: LogColor | undefined): string | undefined {
	if (!color) return undefined;
	if (color.rgb) {
		const [r, g, b] = color.rgb;
		return `rgb(${r},${g},${b})`;
	}
	if (color.idx !== undefined) {
		const idx = color.idx;
		if (idx < 16) return ANSI_16_VARS[idx];
		if (idx < 232) return ansi256CubeToHex(idx);
		return ansi256GrayToHex(idx);
	}
	return undefined;
}

/** Build a CSS style object for a LogSpan. Returns undefined if no styling needed. */
export function spanStyle(span: LogSpan): Record<string, string> | undefined {
	const s: Record<string, string> = {};
	let hasStyle = false;

	const fg = logColorToCss(span.fg);
	if (fg) {
		s.color = fg;
		hasStyle = true;
	}

	const bg = logColorToCss(span.bg);
	if (bg) {
		s["background-color"] = bg;
		hasStyle = true;
	}

	if (span.bold) {
		s["font-weight"] = "600";
		hasStyle = true;
	}
	if (span.italic) {
		s["font-style"] = "italic";
		hasStyle = true;
	}
	if (span.underline) {
		s["text-decoration"] = "underline";
		hasStyle = true;
	}

	return hasStyle ? s : undefined;
}

/**
 * Everything derived from a LogLine, memoized on the line object itself.
 *
 * A LogLine is final once `normalizeLogLine` has produced it, and the scrollback
 * keeps the same objects across frames — only the screen rows are replaced.
 * Deriving per frame therefore repeated identical work for every line on screen:
 * the plain text (a `map` + `join`) on every keystroke of the filter, the
 * box-drawing scan on every frame, and — worst — a fresh block wrapper per line,
 * which handed Solid's reference-keyed `<For>` zero identity matches and made it
 * rebuild the entire rendered DOM.
 *
 * Caching on the line keeps those wrappers stable, so unchanged lines keep their
 * DOM nodes. A `WeakMap` means lines dropped from the scrollback take their
 * cache with them.
 */
interface LineDerived {
	text?: string;
	textLower?: string;
	boxDrawing?: boolean;
	/** Wrapper handed to `<For>` when this line stands alone. */
	textBlock?: LineBlock;
	/** Wrapper handed to `<For>` when this line opens a table group. */
	tableBlock?: { type: "table"; lines: LogLine[] };
}

const derivedCache = new WeakMap<LogLine, LineDerived>();

function derived(line: LogLine): LineDerived {
	let d = derivedCache.get(line);
	if (!d) {
		d = {};
		derivedCache.set(line, d);
	}
	return d;
}

/** Whether a line contains Unicode box-drawing characters (U+2500–U+257F). */
const BOX_DRAWING_RE = /[\u2500-\u257F]/;

export function hasBoxDrawing(line: LogLine): boolean {
	const d = derived(line);
	if (d.boxDrawing === undefined) {
		d.boxDrawing = line.spans.some((span) => BOX_DRAWING_RE.test(span.text));
	}
	return d.boxDrawing;
}

/** A block of lines: either a single text line or consecutive box-drawing lines. */
export type LineBlock = { type: "text"; line: LogLine } | { type: "table"; lines: LogLine[] };

/** Stable wrapper for a standalone line. */
function textBlockFor(line: LogLine): LineBlock {
	const d = derived(line);
	if (!d.textBlock) d.textBlock = { type: "text", line };
	return d.textBlock;
}

/**
 * Stable wrapper for a table group, keyed on the line that opens it. Reused only
 * while the group holds exactly the same lines — a table that gained or lost a
 * row is a different block and has to re-render.
 */
function tableBlockFor(lines: LogLine[]): LineBlock {
	const d = derived(lines[0]);
	const cached = d.tableBlock;
	if (cached && cached.lines.length === lines.length && cached.lines.every((l, i) => l === lines[i])) {
		return cached;
	}
	d.tableBlock = { type: "table", lines };
	return d.tableBlock;
}

/** Group lines into blocks: consecutive box-drawing lines become one table block. */
export function groupLineBlocks(lines: LogLine[]): LineBlock[] {
	const blocks: LineBlock[] = [];
	let tableGroup: LogLine[] = [];
	for (const line of lines) {
		if (hasBoxDrawing(line)) {
			tableGroup.push(line);
		} else {
			if (tableGroup.length > 0) {
				blocks.push(tableBlockFor(tableGroup));
				tableGroup = [];
			}
			blocks.push(textBlockFor(line));
		}
	}
	if (tableGroup.length > 0) {
		blocks.push(tableBlockFor(tableGroup));
	}
	return blocks;
}

function sameColor(a: LogColor | undefined, b: LogColor | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.idx !== b.idx) return false;
	if (a.rgb === b.rgb) return true;
	if (!a.rgb || !b.rgb) return false;
	return a.rgb[0] === b.rgb[0] && a.rgb[1] === b.rgb[1] && a.rgb[2] === b.rgb[2];
}

/**
 * Whether two lines would render identically.
 *
 * The backend re-serializes the whole screen every frame, so a row that did not
 * change still arrives as a freshly deserialized object. Comparing by value is
 * what lets the view keep the previous frame's line — and with it the block
 * wrapper `<For>` is keyed on, and the DOM nodes behind it.
 */
export function sameLine(a: LogLine, b: LogLine): boolean {
	if (a === b) return true;
	if (a.spans.length !== b.spans.length) return false;
	for (let i = 0; i < a.spans.length; i++) {
		const x = a.spans[i];
		const y = b.spans[i];
		if (x.text !== y.text) return false;
		if (x.bold !== y.bold || x.italic !== y.italic || x.underline !== y.underline) return false;
		if (!sameColor(x.fg, y.fg) || !sameColor(x.bg, y.bg)) return false;
	}
	return true;
}

/** Extract the plain text content of a log line (concatenated spans). */
export function lineText(line: LogLine): string {
	const d = derived(line);
	if (d.text === undefined) d.text = line.spans.map((s) => s.text).join("");
	return d.text;
}

/** Lowercased plain text, cached so filtering costs one `includes` per line. */
function lineTextLower(line: LogLine): string {
	const d = derived(line);
	if (d.textLower === undefined) d.textLower = lineText(line).toLowerCase();
	return d.textLower;
}

/**
 * Case-insensitive substring test against an already-lowercased needle. Callers
 * that filter a whole screen lower the query once instead of once per line.
 */
export function lineMatchesNeedle(line: LogLine, needle: string): boolean {
	if (!needle) return true;
	return lineTextLower(line).includes(needle);
}

/** Check if a log line's text contains the query (case-insensitive). */
export function lineMatchesQuery(line: LogLine, query: string): boolean {
	return lineMatchesNeedle(line, query.toLowerCase());
}

/**
 * Characters that mobile browsers render as color emoji instead of monochrome
 * text glyphs.  Appending U+FE0E (VS15 — text variation selector) after each
 * forces the text presentation so they match the desktop xterm.js look.
 *
 * ● U+25CF  BLACK CIRCLE         — Claude Code / Copilot CLI status bullet
 * ○ U+25CB  WHITE CIRCLE         — Copilot CLI queued indicator
 * ⏺ U+23FA BLACK CIRCLE FOR REC — Claude Code Ink bullet variant
 * ⏵ U+23F5  PLAY BUTTON          — Claude Code subtask indicator
 * • U+2022  BULLET               — Codex CLI spinner
 * ◦ U+25E6  WHITE BULLET         — Codex CLI alternating spinner
 * ∴ U+2234  THEREFORE            — Copilot CLI thinking indicator
 * ✢ U+2722  FOUR TEARDROP STAR   — Claude Code v2.1.63+ status
 * ⚙ U+2699  GEAR                 — tool/settings indicator
 * ✻ U+273B  TEARDROP ASTERISK    — thinking indicator
 * ◉ U+25C9  FISHEYE              — occasional indicator
 */
const EMOJI_PRESENTATION_RE = /[●○⏺⏵•◦∴✢⚙✻◉]/g;

// DEFERRED (2026-08-17) — this still runs for every screen row on every frame:
// rows arrive freshly deserialized, so they have to be normalized before
// `sameLine` can tell whether they changed. Moving the rewrite into the Rust log
// serializer would take it off the main thread and make it truly once-per-row,
// but it would also inject U+FE0E into the wire format every `format=log`
// consumer sees, for a presentation concern only mobile browsers have. The cost
// left here is a regex over a screen's worth of text — a few kilobytes — against
// the thousands of DOM nodes the reuse now saves. Revisit if a profile disagrees.

/** Append VS15 (U+FE0E) to characters that should render as text, not emoji. */
function forceTextPresentation(text: string): string {
	return text.replace(EMOJI_PRESENTATION_RE, (ch) => ch + "\uFE0E");
}

/** Type guard: checks that `value` is a LogLine (object with a `spans` array). */
export function isLogLine(value: unknown): value is LogLine {
	return value !== null && typeof value === "object" && "spans" in value && Array.isArray((value as LogLine).spans);
}

/**
 * Normalize a raw log line value (from HTTP or WebSocket) to a LogLine.
 * Handles both structured LogLine objects and plain string fallback.
 * Also forces text presentation for characters that mobile browsers
 * would otherwise render as color emoji.
 */
export function normalizeLogLine(raw: unknown): LogLine {
	if (typeof raw === "string") {
		return { spans: [{ text: forceTextPresentation(raw) }] };
	}
	if (isLogLine(raw)) {
		// Apply VS15 fixup to every span's text
		for (const span of raw.spans) {
			span.text = forceTextPresentation(span.text);
		}
		// This rewrites the line in place, so anything derived from it before
		// normalization describes the pre-VS15 text and has to be recomputed.
		derivedCache.delete(raw);
		return raw;
	}
	return { spans: [{ text: forceTextPresentation(String(raw)) }] };
}
