/** A snapshot of an xterm buffer row — just the parts the overlay cares about. */
export interface RowSnapshot {
	text: string;
	isWrapped: boolean;
}

/** Re-declared here instead of imported: keeps the helper self-contained and
 *  avoids pulling the full Terminal module into unit tests. Must stay in
 *  sync with the patterns used in Terminal.tsx. */
const SUGGEST_ANCHOR_RE = /^[\s●⏺]*suggest:\s+\S/;
const INTENT_RE = /^intent:\s+\S/;
/** Match a NEW `suggest:` anchor for stop-detection during a continuation
 *  walk. Does NOT require `|` on the same row — the Rust parser allows the
 *  first `|` to arrive on a wrapped continuation line, so a row like
 *  `suggest: long item that wraps...` (with the pipe on the next row) is
 *  still a new block boundary and the walk MUST stop here. (#1380-3b9c) */
const SUGGEST_STOP_RE = /^[\t ]*(?:[●⏺][\t ]+)?suggest:\s+\S/;

/**
 * Given a suggest anchor row at `anchorIndex`, return the 0-based indexes of
 * subsequent rows that should be visually hidden as continuations of the same
 * `suggest: [ … ]` block.
 *
 * The bracket pair bounds the token: the closing `]` is a hard terminator, so
 * the walk simply hides every row after the anchor up to and including the row
 * that carries `]`. A single-line suggest closes on the anchor itself → nothing
 * extra to hide. A new `suggest:`/`intent:` token before the `]` stops the walk
 * defensively. Because the `]` bounds the block, stray pipe rows (Makefile /
 * mermaid / tables) can never be swallowed.
 */
export function continuationRowsAfterSuggest(
	anchorIndex: number,
	totalRows: number,
	getRow: (i: number) => RowSnapshot | null,
): number[] {
	const anchor = getRow(anchorIndex);
	// Single-line bracketed suggest closes on the anchor row.
	if (!anchor || anchor.text.includes("]")) return [];
	const hidden: number[] = [];
	for (let i = anchorIndex + 1; i < totalRows; i++) {
		const row = getRow(i);
		if (!row) break;
		// A new token begins a different block — stop before it.
		if (SUGGEST_STOP_RE.test(row.text) || INTENT_RE.test(row.text)) break;
		hidden.push(i);
		// The closing `]` ends the bracketed token — hide it, then stop.
		if (row.text.includes("]")) break;
	}
	return hidden;
}

/**
 * Determine whether the row at `anchorIndex` is the start of a `suggest: [ … ]`
 * block — i.e. one the Rust parser would accept and render as chips.
 *
 * Requires the bracketed form: a `suggest:` anchor at column 0 that opens a `[`
 * and contains a `|` separator. When the terminal is wide enough both land on
 * the anchor row; on narrow terminals the first `|` may wrap onto a continuation
 * row, so wrapped rows are checked too.
 */
export function isSuggestBlock(
	anchorIndex: number,
	totalRows: number,
	getRow: (i: number) => RowSnapshot | null,
): boolean {
	const row = getRow(anchorIndex);
	if (!row) return false;

	// Must look like a bracketed suggest anchor at column 0.
	if (!SUGGEST_ANCHOR_RE.test(row.text) || !row.text.includes("[")) return false;

	// Fast path: pipe on the same line — classic case.
	if (row.text.includes("|")) return true;

	// Otherwise the first `|` may have wrapped onto a continuation row.
	for (let i = anchorIndex + 1; i < totalRows; i++) {
		const next = getRow(i);
		if (!next?.isWrapped) break;
		if (next.text.includes("|")) return true;
	}

	return false;
}
