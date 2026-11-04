import { describe, expect, it, vi } from "vitest";

import {
	ATTR_BOLD,
	ATTR_DEFAULT_BG,
	ATTR_DEFAULT_FG,
	ATTR_INVERSE,
	ATTR_ITALIC,
	type CellMetrics,
	type DecodedRow,
} from "../canvasTerminalUtils";
import { createGridRenderer } from "../gridRenderer";

// resolveFg/resolveBg/buildFontStyle never touch the 2D context, so a stub ctx
// is fine — these tests lock the pure color/font logic that was moved out of
// CanvasTerminal (pixel paint parity is verified live, not here).
function makeRenderer(fontWeight: number | string = 400) {
	const ctx = {} as unknown as CanvasRenderingContext2D;
	const gr = createGridRenderer(ctx, { fontWeight: () => fontWeight, getFontFamily: () => "monospace" });
	gr.setTheme(DEF_BG, DEF_FG);
	return gr;
}

const DEF_BG = "#101010";
const DEF_FG = "#eeeeee";
const RED = 0xff0000; // packed r<<16|g<<8|b
const BLUE = 0x0000ff;

describe("gridRenderer color resolution", () => {
	it("returns the default fg/bg when the default-attr bit is set", () => {
		const gr = makeRenderer();
		expect(gr.resolveFg(RED, BLUE, ATTR_DEFAULT_FG)).toBe(DEF_FG);
		expect(gr.resolveBg(RED, BLUE, ATTR_DEFAULT_BG)).toBe(DEF_BG);
	});

	it("returns explicit packed colors as rgb() strings", () => {
		const gr = makeRenderer();
		expect(gr.resolveFg(RED, BLUE, 0)).toBe("rgb(255,0,0)");
		expect(gr.resolveBg(RED, BLUE, 0)).toBe("rgb(0,0,255)");
	});

	it("swaps fg/bg under the inverse attribute", () => {
		const gr = makeRenderer();
		// inverse fg uses the bg color (and vice-versa)
		expect(gr.resolveFg(RED, BLUE, ATTR_INVERSE)).toBe("rgb(0,0,255)");
		expect(gr.resolveBg(RED, BLUE, ATTR_INVERSE)).toBe("rgb(255,0,0)");
	});

	// GH #111: `printf '\e[7m \e[0m'` — a reverse-video space with BOTH defaults.
	// The swapped fallbacks must cross over, otherwise the block paints bg-on-bg
	// and the Pi composer caret is invisible.
	it("inverse with both defaults swaps the fallbacks", () => {
		const gr = makeRenderer();
		const a = ATTR_INVERSE | ATTR_DEFAULT_FG | ATTR_DEFAULT_BG;
		expect(gr.resolveBg(RED, BLUE, a)).toBe(DEF_FG);
		expect(gr.resolveFg(RED, BLUE, a)).toBe(DEF_BG);
	});

	it("inverse with an explicit fg keeps that fg as the painted bg", () => {
		const gr = makeRenderer();
		const a = ATTR_INVERSE | ATTR_DEFAULT_BG;
		expect(gr.resolveBg(RED, BLUE, a)).toBe("rgb(255,0,0)");
		expect(gr.resolveFg(RED, BLUE, a)).toBe(DEF_BG);
	});

	it("inverse with an explicit bg keeps that bg as the painted fg", () => {
		const gr = makeRenderer();
		const a = ATTR_INVERSE | ATTR_DEFAULT_FG;
		expect(gr.resolveFg(RED, BLUE, a)).toBe("rgb(0,0,255)");
		expect(gr.resolveBg(RED, BLUE, a)).toBe(DEF_FG);
	});

	it("leaves non-inverse default cells on their own defaults", () => {
		const gr = makeRenderer();
		const a = ATTR_DEFAULT_FG | ATTR_DEFAULT_BG;
		expect(gr.resolveFg(RED, BLUE, a)).toBe(DEF_FG);
		expect(gr.resolveBg(RED, BLUE, a)).toBe(DEF_BG);
	});
});

describe("gridRenderer font style", () => {
	it("builds a plain font string at the default weight", () => {
		const gr = makeRenderer(300);
		expect(gr.buildFontStyle(0, 14, "JetBrains Mono")).toBe("300 14px JetBrains Mono");
	});

	it("uses bold weight for bold cells", () => {
		const gr = makeRenderer(300);
		expect(gr.buildFontStyle(ATTR_BOLD, 14, "JetBrains Mono")).toBe("bold 14px JetBrains Mono");
	});

	it("prefixes italic for italic cells", () => {
		const gr = makeRenderer(400);
		expect(gr.buildFontStyle(ATTR_ITALIC, 16, "Hack")).toBe("italic 400 16px Hack");
	});
});

describe("gridRenderer multi-codepoint cells", () => {
	const metrics: CellMetrics = {
		cellWidth: 8,
		cellHeight: 16,
		baseline: 12,
		fontSize: 14,
		dpr: 1,
		scaledCellWidth: 8,
		scaledCellHeight: 16,
	};

	function paint(codepoint: number, extras: string) {
		const fillText = vi.fn();
		const ctx = { fillText, globalAlpha: 1 } as unknown as CanvasRenderingContext2D;
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		renderer.setTheme(DEF_BG, DEF_FG);
		const row: DecodedRow = {
			index: 0,
			count: 1,
			wrapped: false,
			codepoints: Uint32Array.of(codepoint),
			cellExtras: new Map([[0, extras]]),
			fg: new Uint32Array(1),
			bg: new Uint32Array(1),
			attrs: Uint8Array.of(ATTR_DEFAULT_BG | ATTR_DEFAULT_FG),
		};
		renderer.paintRow(row, 0, metrics);
		return fillText;
	}

	it("shapes a decomposed accent as one font glyph string", () => {
		expect(paint(0x65, "\u0301")).toHaveBeenCalledWith("e\u0301", 0, 12);
	});

	it("routes marked box-drawing cells through font shaping", () => {
		expect(paint(0x2500, "\u0301")).toHaveBeenCalledWith("─\u0301", 0, 12);
	});

	it("preserves an explicit emoji variation selector", () => {
		expect(paint(0x25cf, "\uFE0F")).toHaveBeenCalledWith("●\uFE0F", 0, 12);
	});
});

describe("gridRenderer hiddenRows (#1761-7249)", () => {
	const metrics: CellMetrics = {
		cellWidth: 8,
		cellHeight: 16,
		baseline: 12,
		fontSize: 14,
		dpr: 1,
		scaledCellWidth: 8,
		scaledCellHeight: 16,
	};

	function textRow(index: number, ch: string): DecodedRow {
		return {
			index,
			count: 1,
			wrapped: false,
			codepoints: Uint32Array.of(ch.codePointAt(0) ?? 0),
			fg: new Uint32Array(1),
			bg: new Uint32Array(1),
			attrs: Uint8Array.of(ATTR_DEFAULT_BG | ATTR_DEFAULT_FG),
		};
	}

	function paintedChars(opts: { fullRepaint: boolean; dirtyIndices?: Set<number> }) {
		const fillText = vi.fn();
		const ctx = {
			fillText,
			fillRect: vi.fn(),
			globalAlpha: 1,
			canvas: { width: 100, height: 100 },
		} as unknown as CanvasRenderingContext2D;
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		renderer.setTheme(DEF_BG, DEF_FG);
		const rowMap = new Map([0, 1, 2].map((i) => [i, textRow(i, "ABC"[i])]));
		renderer.paintGrid(rowMap, metrics, { ...opts, hiddenRows: new Set([1]) });
		return fillText.mock.calls.map((c) => c[0]);
	}

	// Catches: one hidden projected row promotes every dirty frame to a full-canvas repaint.
	it("repaints one dirty projected row without repainting the viewport", () => {
		const fillText = vi.fn();
		const fillRect = vi.fn();
		const ctx = {
			fillText,
			fillRect,
			globalAlpha: 1,
			canvas: { width: 100, height: 100 },
		} as unknown as CanvasRenderingContext2D;
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		const rows = new Map([0, 1, 2, 3, 4].map((i) => [i, textRow(i, "ABCDE"[i])]));
		const hiddenRows = new Set([1]);
		renderer.paintGrid(rows, metrics, { fullRepaint: true, hiddenRows });
		fillText.mockClear();
		fillRect.mockClear();
		rows.set(3, textRow(3, "Z"));
		renderer.paintGrid(rows, metrics, { fullRepaint: false, dirtyIndices: new Set([3]), hiddenRows });
		expect(fillText.mock.calls).toEqual([["Z", 0, 44]]);
		expect(fillRect.mock.calls).toEqual([[-6, 32, 100, 16]]);
	});

	function projectedPainter() {
		const fillText = vi.fn();
		const fillRect = vi.fn();
		const ctx = {
			fillText,
			fillRect,
			globalAlpha: 1,
			canvas: { width: 100, height: 100 },
		} as unknown as CanvasRenderingContext2D;
		const renderer = createGridRenderer(ctx, { fontWeight: () => 400, getFontFamily: () => "monospace" });
		const rows = new Map([0, 1, 2, 3, 4].map((i) => [i, textRow(i, "ABCDE"[i])]));
		const paint = (hiddenRows: Set<number>, fullRepaint = false, dirtyIndices = new Set<number>()) => {
			fillText.mockClear();
			fillRect.mockClear();
			renderer.paintGrid(rows, metrics, { fullRepaint, dirtyIndices, hiddenRows });
		};
		return { renderer, rows, paint, fillText, fillRect };
	}

	// Catches: a dirty omitted backend row clears a visible row at its unprojected coordinate.
	it("does not clear visible content for a dirty hidden row", () => {
		const { paint, fillText, fillRect } = projectedPainter();
		paint(new Set([1]), true);
		paint(new Set([1]), false, new Set([1]));
		expect(fillText).not.toHaveBeenCalled();
		expect(fillRect).not.toHaveBeenCalled();
	});

	// Catches: inserting/removing a hidden row leaves shifted glyphs or stale text in the old bottom slot.
	it("repaints only slots affected by projection insertion and removal", () => {
		const { paint, fillText, fillRect } = projectedPainter();
		paint(new Set([1]), true);
		paint(new Set([1, 2]));
		expect(fillText.mock.calls).toEqual([
			["D", 0, 28],
			["E", 0, 44],
		]);
		expect(fillRect.mock.calls).toEqual([
			[-6, 16, 100, 16],
			[-6, 32, 100, 16],
			[-6, 48, 100, 16],
		]);
		paint(new Set());
		expect(fillText.mock.calls).toEqual([
			["B", 0, 28],
			["C", 0, 44],
			["D", 0, 60],
			["E", 0, 76],
		]);
		expect(fillRect.mock.calls.every((call) => call[3] === 16)).toBe(true);
	});

	// Catches: toggling answer-marker columns without moving rows leaves the old glyph on the canvas.
	it("repaints a changed answer-marker span without touching other rows", () => {
		const { renderer, rows, fillText, fillRect } = projectedPainter();
		const marked = textRow(0, "💬");
		marked.count = 2;
		marked.codepoints = Uint32Array.of(0x1f4ac, 0x58);
		marked.fg = new Uint32Array(2);
		marked.bg = new Uint32Array(2);
		marked.attrs = Uint8Array.of(ATTR_DEFAULT_BG | ATTR_DEFAULT_FG, ATTR_DEFAULT_BG | ATTR_DEFAULT_FG);
		rows.set(0, marked);
		renderer.paintGrid(rows, metrics, { fullRepaint: true });
		fillText.mockClear();
		fillRect.mockClear();
		renderer.paintGrid(rows, metrics, {
			fullRepaint: false,
			dirtyIndices: new Set(),
			hiddenAnswerMarkers: new Set([0]),
		});
		expect(fillText.mock.calls).toEqual([["X", 0, 12]]);
		expect(fillRect.mock.calls).toEqual([[-6, 0, 100, 16]]);
	});

	// catches: a hidden marker row is still painted, so its text shows on the canvas
	it("paints no glyph for a hidden row on a full repaint", () => {
		expect(paintedChars({ fullRepaint: true })).toEqual(["A", "C"]);
	});

	// catches: the incremental path repaints a hidden dirty row from its text
	it("paints no glyph for a hidden row on an incremental repaint", () => {
		expect(paintedChars({ fullRepaint: false, dirtyIndices: new Set([0, 1, 2]) })).toEqual(["A", "C"]);
	});
});
