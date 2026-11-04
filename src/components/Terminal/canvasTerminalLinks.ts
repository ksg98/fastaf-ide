export interface LinkSpan {
	colStart: number;
	colEnd: number;
}

export function spanAt(spans: readonly LinkSpan[] | undefined, col: number): LinkSpan | undefined {
	return spans?.find((sp) => col >= sp.colStart && col < sp.colEnd);
}

export function isOverSpan(spans: readonly LinkSpan[] | undefined, col: number): boolean {
	return spanAt(spans, col) !== undefined;
}

/**
 * Whether a press under mouse reporting belongs to the underlined link beneath
 * the pointer instead of the app. The underline promises that a click opens the
 * link, so the left and right buttons must not be forwarded there; the middle
 * button stays the app's.
 */
export function linkClaimsPress(button: number, overLink: boolean): boolean {
	return overLink && (button === 0 || button === 2);
}

/** The underlined span a left press landed on, and the text it underlined at that moment. */
export interface ClaimedPress {
	row: number;
	span: LinkSpan;
	target: string;
}

/**
 * The one record of a link press. A link opens only for a left press that began
 * on an underlined span and ended on that same span still underlining the same
 * text — never from a stale hover, a drag-select that happens to end on a path,
 * a press the app received, or another link a redraw moved under the pointer.
 */
export interface LinkPressTracker {
	/** Record a press; a left press on a span is claimed, any other press forgets the last claim. */
	begin(button: number, row: number, span: LinkSpan | undefined, target: string): void;
	/** True between a claimed press and its release. */
	isClaimed(): boolean;
	/** The claim when the release is on its span and `target` (the text under the pointer now) is the pressed one, else null. The claim is consumed either way. */
	release(row: number, col: number, target: string): ClaimedPress | null;
}

export function createLinkPressTracker(): LinkPressTracker {
	let claim: ClaimedPress | null = null;
	return {
		begin(button, row, span, target) {
			claim = button === 0 && span ? { row, span, target } : null;
		},
		isClaimed() {
			return claim !== null;
		},
		release(row, col, target) {
			const held = claim;
			claim = null;
			return held && held.row === row && isOverSpan([held.span], col) && held.target === target ? held : null;
		},
	};
}

/** Whether the resolved link under the pointer covers the cell (single row or wrapped rows). */
export function linkCovers(
	link: {
		row: number;
		colStart: number;
		colEnd: number;
		spans?: readonly { row: number; colStart: number; colEnd: number }[];
	},
	row: number,
	col: number,
): boolean {
	const spans = link.spans ?? [link];
	return spans.some((sp) => sp.row === row && col >= sp.colStart && col < sp.colEnd);
}

export interface ResolvedRowLink {
	text: string;
	path: string;
	line?: number;
	col?: number;
	index: number;
}

export interface FileLinkCacheEntry {
	spans: LinkSpan[] | null;
	ts: number;
}

export interface CanvasLinkController {
	readonly rowCache: Map<string, ResolvedRowLink[] | null>;
	readonly fileCache: Map<string, FileLinkCacheEntry>;
	readonly detectedSpans: Map<number, LinkSpan[]>;
	readonly wrappedSpans: Map<number, LinkSpan[]>;
	beginCheck: () => number;
	isCurrent: (generation: number) => boolean;
	scheduleVerification: (verify: () => void | Promise<void>) => void;
	clearDetected: () => void;
	dispose: () => void;
}

export function createCanvasLinkController(delayMs = 150): CanvasLinkController {
	const rowCache = new Map<string, ResolvedRowLink[] | null>();
	const fileCache = new Map<string, FileLinkCacheEntry>();
	const detectedSpans = new Map<number, LinkSpan[]>();
	const wrappedSpans = new Map<number, LinkSpan[]>();
	let generation = 0;
	let verificationTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	return {
		rowCache,
		fileCache,
		detectedSpans,
		wrappedSpans,
		beginCheck() {
			return ++generation;
		},
		isCurrent(candidate) {
			return !disposed && candidate === generation;
		},
		scheduleVerification(verify) {
			if (disposed || verificationTimer !== undefined) return;
			verificationTimer = setTimeout(() => {
				verificationTimer = undefined;
				if (!disposed) void verify();
			}, delayMs);
		},
		clearDetected() {
			generation++;
			if (verificationTimer !== undefined) clearTimeout(verificationTimer);
			verificationTimer = undefined;
			detectedSpans.clear();
			wrappedSpans.clear();
		},
		dispose() {
			disposed = true;
			generation++;
			if (verificationTimer !== undefined) clearTimeout(verificationTimer);
			verificationTimer = undefined;
			rowCache.clear();
			fileCache.clear();
			detectedSpans.clear();
			wrappedSpans.clear();
		},
	};
}
