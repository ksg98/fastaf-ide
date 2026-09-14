// --- Binary frame decoding and font measurement for CanvasTerminal ---

// Layout constants
export const GUTTER_PX = 6;
export const SCROLLBAR_PX = 14;

// Wire format constants (must match terminal_grid.rs)
const HEADER_SIZE = 26;
const CELL_SIZE = 11; // 4 (char u32) + 3 (fg) + 3 (bg) + 1 (attrs)
export const ATTR_BOLD = 0x01;
export const ATTR_ITALIC = 0x02;
export const ATTR_UNDERLINE = 0x04;
export const ATTR_STRIKEOUT = 0x08;
export const ATTR_DIM = 0x10;
export const ATTR_INVERSE = 0x20;
export const ATTR_DEFAULT_FG = 0x40;
export const ATTR_DEFAULT_BG = 0x80;

/** Bit 15 of the wire `col_count`: this row continues onto the next display row.
 *  Mirrors `ROW_WRAPPED_FLAG` in src-tauri/src/terminal_grid.rs — the grid is the
 *  only place that knows a line wrapped, and the overlay needs it to mask a
 *  wrapped `suggest:` block (#8fc7). */
const ROW_WRAPPED_FLAG = 0x8000;

/** Bit 14 of the wire `col_count`: this row carries only its damaged columns.
 *  A `start_col: u16` follows the count and the payload is `count` cells from
 *  that column; `decodeBinaryFrame` merges them into the row already on screen.
 *  Mirrors `ROW_PARTIAL_FLAG` in src-tauri/src/terminal_grid.rs, which documents
 *  why this is a flag and not a header version. A backend that predates it never
 *  sets the bit, so this decoder keeps taking the whole-row path unchanged. */
const ROW_PARTIAL_FLAG = 0x4000;

export interface DecodedRow {
	index: number;
	count: number;
	/** True when the line continues onto the next display row. */
	wrapped: boolean;
	/** Unicode codepoints; 0 = empty cell */
	codepoints: Uint32Array;
	/** Packed fg color: r<<16|g<<8|b (valid when ATTR_DEFAULT_FG not set) */
	fg: Uint32Array;
	/** Packed bg color: r<<16|g<<8|b (valid when ATTR_DEFAULT_BG not set) */
	bg: Uint32Array;
	/** Per-cell ATTR_* bitmask */
	attrs: Uint8Array;
}

/**
 * Text of a decoded row, built at most once per row object.
 *
 * A single frame asks the same row for its text several times over — the
 * dirty-row prefilter, the suggest-overlay scan, the file-link scan — and each
 * ask concatenated the whole row character by character. `decodeBinaryFrame`
 * allocates a fresh row (and fresh typed arrays) for every changed row and never
 * mutates one in place, so object identity is a sound cache key: the same object
 * always describes the same cells. A `WeakMap` means a row that scrolls out of
 * the frame takes its entry with it — no eviction policy to get wrong.
 */
const rowTextCache = new WeakMap<DecodedRow, string>();

export function rowText(row: DecodedRow): string {
	const cached = rowTextCache.get(row);
	if (cached !== undefined) return cached;
	let text = "";
	for (let ci = 0; ci < row.count; ci++) {
		const cp = row.codepoints[ci];
		text += cp === 0 ? " " : String.fromCodePoint(cp);
	}
	rowTextCache.set(row, text);
	return text;
}

export interface DecodedFrame {
	cursorRow: number;
	cursorCol: number;
	cursorVisible: boolean;
	cursorShape: "block" | "underline" | "beam";
	displayOffset: number;
	historySize: number;
	/** Lines evicted from the history top so far (monotonic within a resize era).
	 *  `historyBase + (historySize - displayOffset + screenRow)` is an
	 *  eviction-stable absolute row index — the key space for the scroll row cache. */
	historyBase: number;
	hasSelection: boolean;
	keyboardFlags: number;
	/** Alternate screen active. `historyBase` restarts from 0 on every alt
	 *  enter/exit, so the absolute-row cache MUST be dropped when this flips —
	 *  otherwise a primary-screen row can alias onto an alt row at the same key. */
	altScreen: boolean;
	bell: boolean;
	mouseMode: 0 | 1 | 2 | 3;
	sgrMouse: boolean;
	focusReporting: boolean;
	bracketedPaste: boolean;
	screenRows: number;
	screenCols: number;
	rows: DecodedRow[];
	/** A ROW_PARTIAL_FLAG row arrived with no row on screen to merge into, so its
	 *  untouched columns are unknown and it was dropped. The caller must pull a
	 *  full frame rather than paint a row with holes in it. */
	needsFullFrame: boolean;
}

/** Previous frame geometry/scroll state needed to decide what a new frame implies. */
export interface FrameGridPrev {
	lastScreenRows: number;
	lastScreenCols: number;
	lastDisplayOffset: number;
	lastHistorySize: number;
	lastAltScreen: boolean;
}

/** What a newly-decoded frame means for the rowMap. */
export interface FrameGridDecision {
	geomChanged: boolean;
	scrollChanged: boolean;
	/** Primary/alternate grid swap: all absolute row state belongs to a new era. */
	screenChanged: boolean;
	/** The frame carries a full screen of rows → replace the rowMap wholesale. */
	fullReplace: boolean;
	/** Partial frame after a scroll → clear and wait for a full frame; do NOT merge. */
	scrollWait: boolean;
}

/**
 * Decide what a decoded frame implies for the rowMap (geom/scroll/full-replace/
 * scroll-wait). Pure, so onFrame's grid bookkeeping is unit-testable away from the
 * CanvasTerminal closure.
 *
 * `fallbackRows` is the screen-row count to assume when the frame omits its own
 * (frame.screenRows === 0): onFrame passes lastResizeRows. The backend always sets
 * frame.screenRows in practice, so the fallback only differs on degenerate frames.
 */
export function decideFrameGrid(prev: FrameGridPrev, frame: DecodedFrame, fallbackRows: number): FrameGridDecision {
	const geomChanged = frame.screenRows !== prev.lastScreenRows || frame.screenCols !== prev.lastScreenCols;
	const scrollChanged = frame.displayOffset !== prev.lastDisplayOffset || frame.historySize !== prev.lastHistorySize;
	const screenChanged = frame.altScreen !== prev.lastAltScreen;
	const screenRowCount = frame.screenRows || fallbackRows || 24;
	const fullReplace = frame.rows.length >= screenRowCount;
	const scrollWait = !fullReplace && (screenChanged || (scrollChanged && !geomChanged));
	return { geomChanged, scrollChanged, screenChanged, fullReplace, scrollWait };
}

/** Inputs to the reconcile-fire gate (see shouldFireReconcile). */
export interface ReconcileGate {
	alive: boolean;
	/** Off-screen (background tab): nothing it pulls back can be seen. */
	hidden: boolean;
	isScrolling: boolean;
	/** Smooth-scroll fractional position; null when at rest on a line. */
	scrollPosF: number | null;
	/** Backend display offset of the current frame (0 = following output, <0 = no frame). */
	displayOffset: number;
}

/**
 * Whether a debounced full-frame reconciliation should actually fire.
 *
 * Partial frames merge into the rowMap by index, so a grid content shift can
 * strand stale rows (duplicate/vanished blocks) on the canvas while the grid
 * itself stays correct. scheduleReconcile() requests a full frame to self-heal,
 * but ONLY when the terminal is at rest and following output (offset 0). Firing
 * mid-gesture or while scrolled back would fight the active render or yank the
 * view. Pure, so the gate is unit-testable away from the CanvasTerminal closure.
 *
 * `hidden` belongs here for cost, not correctness: a background tab is
 * `display:none` and never unmounted, and its rowMap is cleared on hide, so every
 * partial frame it receives schedules a reconcile. Each fire forces
 * `grid_force_full_damage()` — the most expensive frame there is — to be built,
 * shipped, decoded and dropped, once a second, per hidden tab. The show path
 * requests a fresh full frame anyway, so nothing is lost by staying quiet.
 */
export function shouldFireReconcile(g: ReconcileGate): boolean {
	return g.alive && !g.hidden && !g.isScrolling && g.scrollPosF == null && g.displayOffset === 0;
}

/** Leading-edge throttle (see createLeadingThrottle). */
export interface LeadingThrottle {
	/** Something happened: run now, or once the current window closes. */
	trigger(): void;
	/** Drop a pending run (unmount, or the work stopped being wanted). */
	cancel(): void;
}

/**
 * Run `work` on the first trigger, then at most once per `intervalMs`.
 *
 * The search refresh used a trailing debounce, which reset its timer on every
 * frame. A redrawing TUI emits frames far faster than the window, so the timer
 * never expired and the search did not refresh at all while the screen was busy
 * — precisely when its matches are going stale. Leading-edge inverts that: the
 * first frame refreshes immediately, and a continuous stream still refreshes at
 * a bounded rate instead of never.
 *
 * A trailing run fires only if something was triggered inside the window, so an
 * idle terminal schedules nothing.
 */
export function createLeadingThrottle(work: () => void, intervalMs: number): LeadingThrottle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending = false;

	const closeWindow = () => {
		timer = null;
		if (!pending) return;
		pending = false;
		openWindow();
		work();
	};
	const openWindow = () => {
		timer = setTimeout(closeWindow, intervalMs);
	};

	return {
		trigger() {
			if (timer != null) {
				pending = true;
				return;
			}
			openWindow();
			work();
		},
		cancel() {
			if (timer != null) clearTimeout(timer);
			timer = null;
			pending = false;
		},
	};
}

/** Trailing ack scheduler for a hidden terminal (see createHiddenAckThrottle). */
export interface HiddenAckThrottle {
	/** A frame arrived while hidden: arm the trailing ack if it is not already armed. */
	schedule(): void;
	/** Drop a pending ack (unmount, resubscribe, or the terminal became visible). */
	cancel(): void;
}

/**
 * Acknowledge frames received while hidden — late, and at most once per interval.
 *
 * A hidden terminal decodes each frame (the bell rides in the header) but paints
 * nothing, so acking per frame would reopen the delivery gate at full rate for a
 * viewport nobody can see. Never acking is worse than it looks: the gate then
 * stays closed until the backend ticker declares the frontend stuck, which costs
 * a warning per output burst and pins the hidden tab to the 500 ms force-reset
 * floor anyway.
 *
 * One trailing ack per interval gets both: the hidden tab keeps receiving frames
 * at ~1/interval, and the "gate stuck" warning goes back to meaning what it says.
 * Call with an interval BELOW the backend's MAX_IN_FLIGHT_MS so the gate reopens
 * on its own before the ticker gives up on the frame.
 */
export function createHiddenAckThrottle(ack: () => void, intervalMs: number): HiddenAckThrottle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return {
		schedule() {
			if (timer != null) return;
			timer = setTimeout(() => {
				timer = null;
				ack();
			}, intervalMs);
		},
		cancel() {
			if (timer == null) return;
			clearTimeout(timer);
			timer = null;
		},
	};
}

/**
 * Terminal grid dimensions for a pixel box — THE single source of truth shared
 * by CanvasTerminal's remeasure and Terminal's reconnect path. The width loses
 * the left gutter and the scrollbar strip before dividing into columns.
 *
 * Keeping both callers on this one formula matters: when the reconnect resize
 * (Terminal.tsx initSession) computed columns from the RAW width, it disagreed
 * with CanvasTerminal by ~2 cols, so every tab re-entry fired TWO SIGWINCHes
 * with different widths — and each one makes Ink (Claude Code) clear+reprint
 * its full frame, duplicating blocks into scrollback (mdkb
 * `ink-banner-dup-raw-ring-2026-07-06`). Identical dims instead hit the
 * backend's resize no-op guard: zero spurious SIGWINCH.
 */
export function gridDimsForBox(
	widthPx: number,
	heightPx: number,
	cellWidth: number,
	cellHeight: number,
): { rows: number; cols: number } {
	return {
		cols: Math.floor((widthPx - GUTTER_PX - SCROLLBAR_PX) / cellWidth),
		rows: Math.floor(heightPx / cellHeight),
	};
}

/** Trailing-debounce window for the full-frame reconcile self-heal. */
export const RECONCILE_DEBOUNCE_MS = 250;
/** Hard cap on how long a reschedule burst can defer the reconcile. */
export const RECONCILE_MAX_WAIT_MS = 1_000;

/**
 * Delay for the (re)scheduled reconcile timer: a plain trailing debounce
 * (RECONCILE_DEBOUNCE_MS) capped so the timer fires no later than
 * `burstStartedAt + RECONCILE_MAX_WAIT_MS`.
 *
 * Without the cap, sustained partial-frame output (an active agent repainting
 * every 16-33ms for minutes) resets the debounce on every frame and the
 * self-heal never fires — stale rows stranded on the canvas persist for the
 * whole burst (mdkb `ink-banner-dup-raw-ring-2026-07-06`). With the cap, the
 * heal runs at most ~1/s under continuous output and keeps the cheap trailing
 * behavior for short bursts. Pure, unit-tested.
 */
export function reconcileDelay(now: number, burstStartedAt: number): number {
	const deadline = burstStartedAt + RECONCILE_MAX_WAIT_MS;
	return Math.max(0, Math.min(RECONCILE_DEBOUNCE_MS, deadline - now));
}

export interface CellMetrics {
	cellWidth: number;
	cellHeight: number;
	baseline: number;
	fontSize: number;
	dpr: number;
	scaledCellWidth: number;
	scaledCellHeight: number;
}

/**
 * Decode a binary grid frame from the Rust backend into structured data.
 *
 * `base` is the rows currently on screen, keyed by row index. It is only read for
 * ROW_PARTIAL_FLAG rows, which carry just their damaged columns and need the rest
 * of the line from somewhere. Every row this returns is full width, so callers
 * downstream never learn that partial rows exist.
 *
 * Rows are rebuilt, never mutated: `rowTextCache` keys off row identity, and the
 * row it is merging from may still be referenced by the scroll cache.
 */
export function decodeBinaryFrame(buffer: ArrayBuffer, base?: ReadonlyMap<number, DecodedRow>): DecodedFrame | null {
	if (buffer.byteLength < HEADER_SIZE) return null;

	const view = new DataView(buffer);
	let offset = 0;

	const numRows = view.getUint16(offset, true);
	offset += 2;
	const cursorRow = view.getUint16(offset, true);
	offset += 2;
	const cursorCol = view.getUint16(offset, true);
	offset += 2;
	const cursorVisible = view.getUint8(offset) !== 0;
	offset += 1;
	const displayOffset = view.getUint32(offset, true);
	offset += 4;
	const historySize = view.getUint32(offset, true);
	offset += 4;
	const hasSelection = view.getUint8(offset) !== 0;
	offset += 1;
	const rawKeyboardFlags = view.getUint8(offset);
	offset += 1;
	const frameFlags = view.getUint8(offset);
	offset += 1;
	const screenRows = view.getUint16(offset, true);
	offset += 2;
	const screenCols = view.getUint16(offset, true);
	offset += 2;
	const historyBase = view.getUint32(offset, true);
	offset += 4;
	// bit5 of keyboard_flags is the alt-screen state, not a keyboard flag — it
	// rides there because frame_flags is full (see serialize_dirty_rows).
	const altScreen = (rawKeyboardFlags & 0x20) !== 0;
	const keyboardFlags = rawKeyboardFlags & 0x1f;
	const bell = (frameFlags & 0x01) !== 0;
	const cursorShapeRaw = (frameFlags >> 1) & 0x03;
	const cursorShape: "block" | "underline" | "beam" =
		cursorShapeRaw === 2 ? "beam" : cursorShapeRaw === 1 ? "underline" : "block";
	const mouseMode = ((frameFlags >> 3) & 0x03) as 0 | 1 | 2 | 3;
	const sgrMouse = (frameFlags & 0x20) !== 0;
	const focusReporting = (frameFlags & 0x40) !== 0;
	const bracketedPaste = (frameFlags & 0x80) !== 0;

	// DEFERRED (2026-08-20) — F29, pooling these four typed arrays across frames.
	// It cannot be done as the audit describes: rows outlive the frame. They are
	// retained by the scroll `rowCache` (bounded at ROW_CACHE_MAX) and used as
	// `rowTextCache` WeakMap keys, so a reused buffer would alias a cached row onto
	// a later frame's cells. The paint half of F29 is already done — gridRenderer
	// batches font/fillStyle changes and caches every colour and font string — and
	// its glyph-run batching was deliberately rejected there, because `cellWidth`
	// is rounded and batched `fillText` runs accumulate sub-pixel cursor drift.
	const rows: DecodedRow[] = [];
	let needsFullFrame = false;
	for (let r = 0; r < numRows; r++) {
		if (offset + 4 > buffer.byteLength) break;
		const rowIndex = view.getUint16(offset, true);
		offset += 2;
		const rawColCount = view.getUint16(offset, true);
		offset += 2;
		const wrapped = (rawColCount & ROW_WRAPPED_FLAG) !== 0;
		const partial = (rawColCount & ROW_PARTIAL_FLAG) !== 0;
		const colCount = rawColCount & ~(ROW_WRAPPED_FLAG | ROW_PARTIAL_FLAG);
		let startCol = 0;
		if (partial) {
			if (offset + 2 > buffer.byteLength) break;
			startCol = view.getUint16(offset, true);
			offset += 2;
		}

		// A partial row describes an edit to the line already on screen. Without
		// that line the untouched columns are unknown, so drop the row and let the
		// caller pull a full frame — painting a half-known row would leave holes
		// that nothing repairs until the next reconcile.
		const previous = partial ? base?.get(rowIndex) : undefined;
		if (partial && !previous) {
			needsFullFrame = true;
			offset += colCount * CELL_SIZE;
			continue;
		}

		const width = previous ? previous.count : colCount;
		const codepoints = previous ? new Uint32Array(previous.codepoints) : new Uint32Array(colCount);
		const fg = previous ? new Uint32Array(previous.fg) : new Uint32Array(colCount);
		const bg = previous ? new Uint32Array(previous.bg) : new Uint32Array(colCount);
		const attrs = previous ? new Uint8Array(previous.attrs) : new Uint8Array(colCount);

		for (let i = 0; i < colCount; i++) {
			if (offset + CELL_SIZE > buffer.byteLength) break;
			const c = startCol + i;
			const cp = view.getUint32(offset, true);
			offset += 4;
			const fgR = view.getUint8(offset++);
			const fgG = view.getUint8(offset++);
			const fgB = view.getUint8(offset++);
			const bgR = view.getUint8(offset++);
			const bgG = view.getUint8(offset++);
			const bgB = view.getUint8(offset++);
			const a = view.getUint8(offset++);
			// A resize can land a span past the row we are merging into. The next
			// frame is full (geometry change forces full damage), so skipping is
			// enough — but writing past the end would silently drop the cell.
			if (c >= width) continue;
			codepoints[c] = cp;
			attrs[c] = a;
			fg[c] = (fgR << 16) | (fgG << 8) | fgB;
			bg[c] = (bgR << 16) | (bgG << 8) | bgB;
		}

		rows.push({ index: rowIndex, count: width, wrapped, codepoints, fg, bg, attrs });
	}

	return {
		cursorRow,
		cursorCol,
		cursorVisible,
		cursorShape,
		displayOffset,
		historySize,
		historyBase,
		hasSelection,
		keyboardFlags,
		altScreen,
		bell,
		mouseMode,
		sgrMouse,
		focusReporting,
		bracketedPaste,
		screenRows,
		screenCols,
		rows,
		needsFullFrame,
	};
}

/** A styled row tagged with its absolute index (0 = oldest scrollback line). */
export interface StyledRangeRow {
	abs: number;
	row: DecodedRow;
}

/** A decoded range of styled rows, feeding the client-side scroll row cache. */
export interface StyledRange {
	startAbs: number;
	historySize: number;
	cols: number;
	rows: StyledRangeRow[];
}

/**
 * Decode the styled-row-range payload from `terminal_styled_rows`.
 * Layout mirrors the Rust `serialize_styled_range`: start_abs u32,
 * history_size u32, cols u16, row_count u16, then per row abs u32 + colCount u16
 * + cells (colCount × CELL_SIZE).
 */
export function decodeStyledRange(buffer: ArrayBuffer): StyledRange | null {
	if (buffer.byteLength < 12) return null;
	const view = new DataView(buffer);
	let offset = 0;
	const startAbs = view.getUint32(offset, true);
	offset += 4;
	const historySize = view.getUint32(offset, true);
	offset += 4;
	const cols = view.getUint16(offset, true);
	offset += 2;
	const rowCount = view.getUint16(offset, true);
	offset += 2;

	const rows: StyledRangeRow[] = [];
	for (let r = 0; r < rowCount; r++) {
		if (offset + 6 > buffer.byteLength) break;
		const abs = view.getUint32(offset, true);
		offset += 4;
		const rawColCount = view.getUint16(offset, true);
		offset += 2;
		const wrapped = (rawColCount & ROW_WRAPPED_FLAG) !== 0;
		// Scrollback rows are always whole (see `serialize_styled_range`), but the
		// count field is shared with the dirty-row format, so mask both flags —
		// masking one and not the other is how a flag becomes a width of 16384.
		const colCount = rawColCount & ~(ROW_WRAPPED_FLAG | ROW_PARTIAL_FLAG);
		const codepoints = new Uint32Array(colCount);
		const fg = new Uint32Array(colCount);
		const bg = new Uint32Array(colCount);
		const attrs = new Uint8Array(colCount);
		for (let c = 0; c < colCount; c++) {
			if (offset + CELL_SIZE > buffer.byteLength) break;
			codepoints[c] = view.getUint32(offset, true);
			offset += 4;
			const fgR = view.getUint8(offset++);
			const fgG = view.getUint8(offset++);
			const fgB = view.getUint8(offset++);
			const bgR = view.getUint8(offset++);
			const bgG = view.getUint8(offset++);
			const bgB = view.getUint8(offset++);
			attrs[c] = view.getUint8(offset++);
			fg[c] = (fgR << 16) | (fgG << 8) | fgB;
			bg[c] = (bgR << 16) | (bgG << 8) | bgB;
		}
		rows.push({ abs, row: { index: 0, count: colCount, wrapped, codepoints, fg, bg, attrs } });
	}
	return { startAbs, historySize, cols, rows };
}

/** Snap lineHeight to integer device pixels to prevent sub-pixel seams between rows. */
export function snapLineHeight(fontSize: number, target: number = 1.2): number {
	const dpr = window.devicePixelRatio || 1;
	const rawDevicePx = fontSize * target * dpr;
	const lo = Math.floor(rawDevicePx);
	const hi = Math.ceil(rawDevicePx);
	const best = Math.abs(rawDevicePx - lo) <= Math.abs(rawDevicePx - hi) ? lo : hi;
	const snapped = best / (fontSize * dpr);
	return Math.max(1.0, Math.min(snapped, 1.5));
}

export type CursorShape = "block" | "beam" | "underline";

export interface CursorRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Compute the pixel rectangle for a cursor at the given grid position. */
export function computeCursorRect(shape: CursorShape, row: number, col: number, m: CellMetrics): CursorRect {
	const x = col * m.cellWidth;
	const y = row * m.cellHeight;
	switch (shape) {
		case "block":
			return { x, y, w: m.cellWidth, h: m.cellHeight };
		case "beam":
			return { x, y, w: 2, h: m.cellHeight };
		case "underline":
			return { x, y: y + m.cellHeight - 2, w: m.cellWidth, h: 2 };
	}
}

/**
 * Measure a monospace font and return cell metrics for grid layout.
 * Matches xterm.js WebGL renderer dimension calculation exactly:
 *   device.char.height = ceil(charHeight * dpr)
 *   device.cell.height = floor(device.char.height * lineHeight)
 *   charTop = round((cellHeight_device - charHeight_device) / 2)
 */
export function measureFont(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	fontSize: number,
	fontFamily: string,
	dpr: number = 1,
	lineHeight: number = 1.2,
	fontWeight: number = 400,
	charHeightOverride?: number,
): CellMetrics {
	ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
	const m = ctx.measureText("W");
	const cellWidth = Math.round(m.width);

	const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
	const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
	const charHeightCSS = charHeightOverride ?? ascent + descent;

	// xterm.js WebGL formula: compute in device pixels, then convert back
	const charHeightDevice = Math.ceil(charHeightCSS * dpr);
	const cellHeightDevice = Math.floor(charHeightDevice * lineHeight);
	const charTopDevice = lineHeight === 1 ? 0 : Math.round((cellHeightDevice - charHeightDevice) / 2);

	const cellHeight = cellHeightDevice / dpr;
	const baseline = Math.ceil(ascent) + charTopDevice / dpr;

	return {
		cellWidth,
		cellHeight,
		baseline: Math.max(baseline, 0),
		fontSize,
		dpr,
		scaledCellWidth: cellWidth * dpr,
		scaledCellHeight: cellHeightDevice,
	};
}
