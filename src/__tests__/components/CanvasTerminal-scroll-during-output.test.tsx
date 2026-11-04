import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * A wheel gesture that is still running when output arrives (#1264-89c8).
 *
 * The oracle is the terminal contract, not the implementation: while the user
 * is scrolled back, new output must not move the lines they are reading. The
 * backend grid (alacritty) honours this by raising `display_offset` by exactly
 * the number of lines that scrolled into history. So when the frontend next
 * asks for a viewport, the offset it sends must include those lines — otherwise
 * the view jumps forward by the output and the lines in between are never shown.
 */

const { invoke, frameSink, paintGrid } = vi.hoisted(() => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	paintGrid: vi.fn(),
	frameSink: { current: null as ((data: ArrayBuffer) => void) | null },
}));

vi.mock("../../components/Terminal/canvasTerminalTransport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/canvasTerminalTransport")>()),
	createTransport: () => ({
		onEvent: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn(async (onFrame: (data: ArrayBuffer) => void) => {
			frameSink.current = onFrame;
		}),
		resubscribe: vi.fn().mockResolvedValue(undefined),
		unsubscribe: vi.fn(),
		ackFrame: vi.fn(),
		invoke,
	}),
}));
vi.mock("../../components/Terminal/gridRenderer", () => ({
	createGridRenderer: () => ({ setTheme: vi.fn(), invalidateCaches: vi.fn(), paintGrid, paintRow: vi.fn() }),
}));

import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";

const frameOrigins: Array<{ afterCalls: number; origin: number }> = [];

const ROWS = 4;
const COLS = 8;
const HEADER_SIZE = 26;
const CELL_SIZE = 11;

/** A full-screen frame of `ROWS` rows, each labelled with its all-time line number. */
function fullFrame(opts: {
	historySize: number;
	displayOffset: number;
	historyBase?: number;
	textOf?: (abs: number) => string;
}): ArrayBuffer {
	const historyBase = opts.historyBase ?? 0;
	const top = historyBase + opts.historySize - opts.displayOffset;
	frameOrigins.push({ afterCalls: invoke.mock.calls.length, origin: historyBase + opts.historySize });
	const buffer = new ArrayBuffer(HEADER_SIZE + ROWS * (4 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, ROWS, true);
	view.setUint8(6, 1);
	view.setUint32(7, opts.displayOffset, true);
	view.setUint32(11, opts.historySize, true);
	view.setUint16(18, ROWS, true);
	view.setUint16(20, COLS, true);
	view.setUint32(22, historyBase, true);
	let offset = HEADER_SIZE;
	for (let r = 0; r < ROWS; r++) {
		const text = (opts.textOf?.(top + r) ?? `L${top + r}`).padEnd(COLS, " ");
		view.setUint16(offset, r, true);
		view.setUint16(offset + 2, COLS, true);
		offset += 4;
		for (const char of text) {
			view.setUint32(offset, char.codePointAt(0) ?? 0, true);
			offset += CELL_SIZE;
		}
	}
	return buffer;
}

/**
 * What `terminal_styled_rows` answers: rows `[start, start+count)` that exist —
 * all-time rows `[first, total)`, the ones below `first` evicted — text from `textOf`.
 */
function styledRange(
	start: number,
	count: number,
	total: number,
	historySize: number,
	textOf: (abs: number) => string,
	first = 0,
) {
	const abs = Array.from({ length: count }, (_, i) => start + i).filter((a) => a >= first && a < total);
	const buffer = new ArrayBuffer(12 + abs.length * (6 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint32(0, start, true);
	view.setUint32(4, historySize, true);
	view.setUint16(8, COLS, true);
	view.setUint16(10, abs.length, true);
	let offset = 12;
	for (const a of abs) {
		view.setUint32(offset, a, true);
		view.setUint16(offset + 4, COLS, true);
		offset += 6;
		for (const char of textOf(a).padEnd(COLS, " ")) {
			view.setUint32(offset, char.codePointAt(0) ?? 0, true);
			offset += CELL_SIZE;
		}
	}
	return buffer;
}

/** Text of every row of the last paint, top to bottom; "?" for a row that was not in the cache. */
function paintedLines(): string[] {
	const rows = paintGrid.mock.calls.at(-1)?.[0] as Map<number, { codepoints: Uint32Array }> | undefined;
	if (!rows) return [];
	const last = Math.max(...rows.keys());
	return Array.from({ length: last + 1 }, (_, r) => {
		const row = rows.get(r);
		return row ? String.fromCodePoint(...Array.from(row.codepoints).map((c) => c || 32)).trimEnd() : "?";
	});
}

/** A pane with a real box and a canvas whose every call is a no-op, so cached-row paints run. */
function layOutPane() {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		new Proxy(
			{},
			{
				get: (_t, prop) =>
					prop === "measureText" ? () => ({ width: 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }) : vi.fn(),
			},
		) as unknown as CanvasRenderingContext2D,
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		width: 800,
		height: 1000,
		top: 0,
		left: 0,
		right: 800,
		bottom: 1000,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
}

/** Text of the rows a paint call drew, by viewport row; rows it had no cached row for are absent. */
function rowsOf(rows: Map<number, { codepoints: Uint32Array }>): Map<number, string> {
	return new Map(
		Array.from(rows, ([r, row]) => [
			r,
			String.fromCodePoint(...Array.from(row.codepoints).map((c) => c || 32)).trimEnd(),
		]),
	);
}

/**
 * Every row of every paint since the last `paintGrid.mockClear()` is a real line,
 * and the rows of one paint sit in `truth` at the same distance as on screen:
 * no stale line, no duplicate, no block skipped between two painted rows.
 */
function expectEveryPaintIsARunOf(truth: string[]) {
	const at = new Map(truth.map((line, abs) => [line, abs]));
	for (const [rows] of paintGrid.mock.calls as Array<[Map<number, { codepoints: Uint32Array }>]>) {
		const painted = [...rowsOf(rows)];
		expect(painted.filter(([, line]) => !at.has(line)).map(([, line]) => line)).toEqual([]);
		const [r0, line0] = painted[0] ?? [0, ""];
		for (const [r, line] of painted)
			expect(`${line}@${(at.get(line) ?? 0) - r}`).toBe(`${line}@${(at.get(line0) ?? 0) - r0}`);
	}
}

function sentOffsets(): number[] {
	return invoke.mock.calls.flatMap(([cmd, args], index) => {
		if (cmd !== "terminal_scroll_to_anchor") return [];
		const origin = frameOrigins.findLast((frame) => frame.afterCalls <= index)?.origin ?? 0;
		return [args.anchor == null ? 0 : origin - args.anchor];
	});
}

function wheel(target: Element, deltaY: number) {
	target.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
}

describe("CanvasTerminal scroll gesture during output", () => {
	// FastAF scales wheel input by the user's scroll sensitivity (default 70 %).
	// These cases measure the unscaled gesture geometry, so pin it to 100 %.
	let savedSensitivity = 100;
	beforeEach(() => {
		savedSensitivity = settingsStore.state.terminalScrollSensitivity;
		settingsStore.setTerminalScrollSensitivity(100);
		invoke.mockClear();
		frameOrigins.length = 0;
		frameSink.current = null;
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
		});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			clearRect: vi.fn(),
			setTransform: vi.fn(),
			fillRect: vi.fn(),
			measureText: () => ({ width: 8 }),
		} as unknown as CanvasRenderingContext2D);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
	});

	afterEach(() => {
		settingsStore.setTerminalScrollSensitivity(savedSensitivity);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// Catches: delayed offset application plus the timed settle handoff skips history rows.
	it("delayed scroll application never hands off to newer rows under sustained output", async () => {
		layOutPane();
		let history = 100;
		let output = true;
		invoke.mockImplementation(async (cmd: string, args: Record<string, number>) => {
			if (cmd === "terminal_styled_rows")
				return styledRange(args.start, args.count, history + ROWS, history, (abs) => `L${abs}`);
			if (cmd === "terminal_scroll_to_offset" || cmd === "terminal_scroll_to_anchor") {
				if (output) history += 5; // PTY output wins the lock before this request applies.
				const offset = cmd === "terminal_scroll_to_anchor" ? history - args.anchor : args.offset;
				frameSink.current?.(fullFrame({ historySize: history, displayOffset: offset }));
			}
		});
		const terminalId = terminalsStore.add({
			name: "scroll",
			sessionId: "delayed-scroll",
			fontSize: 14,
			cwd: "/",
			awaitingInput: null,
		});
		const view = render(() => <CanvasTerminal sessionId="delayed-scroll" terminalId={terminalId} />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: history, displayOffset: 20 }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");
			wheel(canvas, -20);
			await waitFor(() => expect(history).toBeGreaterThan(100));
			// Exercise gesture end and the former 400 ms escape hatch.
			await new Promise((resolve) => setTimeout(resolve, 700));
			const top = paintedLines()[0];
			expect(top).toMatch(/^L\d+$/);
			expect(Number(top.slice(1))).toBeLessThanOrEqual(80);
		} finally {
			output = false;
			view.unmount();
			invoke.mockReset().mockResolvedValue(undefined);
		}
	});

	// Catches: an unreachable settle target suppresses live paints forever after scrollback is purged.
	it("resumes live painting when scrollback is purged while a gesture settles", async () => {
		layOutPane();
		invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
			if (cmd !== "terminal_styled_rows") return undefined;
			return styledRange(args.start ?? 0, args.count ?? 0, 104, 100, (abs) => `L${abs}`);
		});
		const view = render(() => <CanvasTerminal sessionId="purged-settle" terminalId="purged-settle" />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 0 }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");
			wheel(canvas, -80);
			await waitFor(() => expect(invoke.mock.calls.some(([cmd]) => cmd === "terminal_scroll_to_anchor")).toBe(true));
			// The gesture end timer is 200 ms; let it enter settlement without an ack frame.
			await new Promise((resolve) => setTimeout(resolve, 250));
			paintGrid.mockClear();
			// clear_history keeps all-time row ids, but removes every history row and returns to tail.
			frameSink.current?.(fullFrame({ historyBase: 100, historySize: 0, displayOffset: 0 }));
			frameSink.current?.(
				fullFrame({ historyBase: 100, historySize: 0, displayOffset: 0, textOf: (abs) => `NEW${abs - 100}` }),
			);
			await waitFor(() => expect(paintedLines()).toEqual(["NEW0", "NEW1", "NEW2", "NEW3"]));
		} finally {
			view.unmount();
		}
	});

	// catches: the gesture keeps its distance-from-bottom while the grid pushes
	// output into history, so the next flush scrolls the backend forward by the
	// output and those lines are skipped.
	it("keeps the lines under the user when output lands mid-gesture", async () => {
		const view = render(() => <CanvasTerminal sessionId="scroll-1264" terminalId="scroll-1264" />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 0 }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");

			wheel(canvas, -80);
			await waitFor(() => expect(sentOffsets().length).toBe(1));
			const firstOffset = sentOffsets()[0];
			expect(firstOffset).toBeGreaterThan(0);

			// The backend applied that offset, then 5 lines of output scrolled into
			// history. Alacritty keeps the viewport still: offset and history both +5.
			frameSink.current?.(fullFrame({ historySize: 105, displayOffset: firstOffset + 5 }));

			// Still the same gesture: scroll up a little more.
			wheel(canvas, -80);
			await waitFor(() => expect(sentOffsets().length).toBe(2));
			const secondOffset = sentOffsets()[1];

			// Scrolling UP can only move the top line to an older one. The line the
			// user was reading is now `firstOffset + 5` from the bottom, so anything
			// smaller jumps the view forward over the new output.
			expect(secondOffset).toBeGreaterThan(firstOffset + 5);
		} finally {
			view.unmount();
		}
	});

	// catches: the scrollbar drag anchors its offset to the frame the drag started
	// on (#1265-8b16), so output landing mid-drag is dropped from the offset it
	// sends and the view jumps forward over those lines.
	it("keeps the top line under a scrollbar drag when output lands mid-drag", async () => {
		layOutPane();
		const view = render(() => <CanvasTerminal sessionId="scroll-1265" terminalId="scroll-1265" />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 50 }));
			const thumb = view.container.querySelector('div[style*="width:14px"] > div');
			if (!thumb) throw new Error("scrollbar thumb not mounted");

			thumb.dispatchEvent(new MouseEvent("mousedown", { clientY: 500, bubbles: true, cancelable: true }));
			document.dispatchEvent(new MouseEvent("mousemove", { clientY: 450, bubbles: true }));
			await waitFor(() => expect(sentOffsets().length).toBe(1));
			const travelled = sentOffsets()[0] - 50;
			expect(travelled).toBeGreaterThan(0);

			// The backend applied that offset, then 5 lines of output scrolled into
			// history: alacritty keeps the viewport still, offset and history both +5.
			frameSink.current?.(fullFrame({ historySize: 105, displayOffset: sentOffsets()[0] + 5 }));

			// The pointer keeps moving in the same drag, the same distance again.
			document.dispatchEvent(new MouseEvent("mousemove", { clientY: 400, bubbles: true }));
			await waitFor(() => expect(sentOffsets().length).toBe(2));

			// Top line = the one the drag had reached, plus what the thumb travelled since.
			// Anchoring to the start frame would send 50 + 2 * travelled: 5 lines forward.
			expect(sentOffsets()[1]).toBeGreaterThanOrEqual(50 + 5 + 2 * travelled - 1);
		} finally {
			document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			view.unmount();
		}
	});

	// catches: a chunk fetched while lines 100-103 were still the agent's live
	// region is cached for good, so once the redraw commits them to history the
	// user scrolling back sees the stale rows instead of the lines that were written.
	it("shows the committed lines, not the live-region rows cached before they were committed", async () => {
		// Backend truth: 100 history lines "H<n>". Lines 100-103 are first the agent's
		// live region ("V<n>"); the redraw then commits lines 100-104 as "F<n>".
		let committed = false;
		const historySize = () => (committed ? 105 : 100);
		const textOf = (abs: number) => (abs < 100 ? `H${abs}` : committed && abs < 105 ? `F${abs}` : `V${abs}`);
		const truth = () => Array.from({ length: historySize() + ROWS }, (_, abs) => textOf(abs));
		invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
			if (cmd !== "terminal_styled_rows") return undefined;
			return styledRange(args.start ?? 0, args.count ?? 0, historySize() + ROWS, historySize(), textOf);
		});
		paintGrid.mockClear();
		layOutPane();
		const view = render(() => <CanvasTerminal sessionId="scroll-1264-live" terminalId="scroll-1264-live" />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 0, textOf }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");

			wheel(canvas, -80);
			await waitFor(() => expect(sentOffsets().length).toBe(1));
			const firstOffset = sentOffsets()[0];
			// The chunk holding lines 64-127 is fetched while 100-103 are still live.
			await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("terminal_styled_rows"));
			await new Promise((r) => setTimeout(r, 20));

			// The redraw commits: 5 lines enter history, the viewport keeps its lines.
			committed = true;
			paintGrid.mockClear();
			frameSink.current?.(fullFrame({ historySize: 105, displayOffset: firstOffset + 5, textOf }));

			// Same gesture, still scrolled back, moving toward the bottom over the rows
			// that were live when the chunk was cached.
			wheel(canvas, 40);
			await new Promise((r) => setTimeout(r, 150));

			// A row painted from the cache is either not known yet or one of the real
			// lines of the output — never what it read before the redraw committed.
			const real = new Set(truth());
			for (const [rows] of paintGrid.mock.calls as Array<[Map<number, { codepoints: Uint32Array }>]>) {
				const lines = Array.from(rows.values(), (row) =>
					String.fromCodePoint(...Array.from(row.codepoints).map((c) => c || 32)).trimEnd(),
				);
				expect(lines.filter((line) => !real.has(line))).toEqual([]);
			}
			// Once the refetch lands, the whole viewport is a run of real lines.
			const lines = paintedLines();
			const start = truth().indexOf(lines[0]);
			expect(start).toBeGreaterThanOrEqual(0);
			expect(lines).toEqual(truth().slice(start, start + lines.length));
		} finally {
			view.unmount();
		}
	});

	// catches: frames that rewrite live rows in place while the backend still lags
	// the gesture are not seeded, so the cache keeps painting the spinner/status
	// text the row held before the rewrite.
	it("paints a live row rewritten in place while the gesture is still running", async () => {
		let spinner = "S1";
		const textOf = (abs: number) => (abs < 100 ? `H${abs}` : abs === 102 ? spinner : `V${abs}`);
		invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
			if (cmd !== "terminal_styled_rows") return undefined;
			return styledRange(args.start ?? 0, args.count ?? 0, 100 + ROWS, 100, textOf);
		});
		paintGrid.mockClear();
		layOutPane();
		const view = render(() => <CanvasTerminal sessionId="scroll-1264-inplace" terminalId="scroll-1264-inplace" />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 0, textOf }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");

			wheel(canvas, -80);
			await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("terminal_styled_rows"));
			await new Promise((r) => setTimeout(r, 20));

			// The agent redraws its spinner row. History does not grow, and the
			// backend has not reached the gesture offset yet (offset 0 != position).
			spinner = "S2";
			frameSink.current?.(fullFrame({ historySize: 100, displayOffset: 0, textOf }));
			await new Promise((r) => setTimeout(r, 100));

			const lines = paintedLines();
			expect(lines).toContain("S2");
			expect(lines).not.toContain("S1");
		} finally {
			view.unmount();
		}
	});

	// At the scrollback cap `historySize` stops moving and only `historyBase`
	// advances: the backend evicts one old line per new one.
	describe("at the scrollback cap", () => {
		const CAP = 200;

		// catches: history growth computed from historySize alone (the #1681 shape):
		// at the cap it reads 0, so the gesture is not rebased over the output and
		// the next flush scrolls the view forward over the lines that just landed.
		it("keeps the lines under the user when output lands mid-gesture", async () => {
			const view = render(() => <CanvasTerminal sessionId="scroll-1264-cap" terminalId="scroll-1264-cap" />);
			try {
				await waitFor(() => expect(frameSink.current).not.toBeNull());
				frameSink.current?.(fullFrame({ historySize: CAP, historyBase: 1000, displayOffset: 0 }));
				const canvas = view.container.querySelector('canvas[tabindex="0"]');
				if (!canvas) throw new Error("terminal canvas not mounted");

				wheel(canvas, -80);
				await waitFor(() => expect(sentOffsets().length).toBe(1));
				const firstOffset = sentOffsets()[0];
				expect(firstOffset).toBeGreaterThan(0);

				// 5 lines of output: 5 evicted at the top, so the history size is unchanged.
				frameSink.current?.(fullFrame({ historySize: CAP, historyBase: 1005, displayOffset: firstOffset + 5 }));

				wheel(canvas, -80);
				await waitFor(() => expect(sentOffsets().length).toBe(2));
				// The same wheel step again, on top of the 5 lines the backend already
				// added to the offset. Not rebased, it sends only 2 * firstOffset.
				expect(sentOffsets()[1]).toBeGreaterThanOrEqual(2 * firstOffset + 5);
			} finally {
				view.unmount();
			}
		});

		// catches: the same growth-from-historySize bug on the commit path: at the cap
		// growth reads 0, commitLiveRows never runs, and the chunk cached while lines
		// 1200-1203 were the live region keeps painting their pre-commit text.
		it("shows the committed lines, not the live-region rows cached before they were committed", async () => {
			let base = 1000;
			let committed = false;
			const liveTop = 1000 + CAP;
			const textOf = (abs: number) =>
				abs < liveTop ? `H${abs}` : committed && abs < liveTop + 5 ? `F${abs}` : `V${abs}`;
			const truth = () =>
				Array.from({ length: base + CAP + ROWS }, (_, abs) => (abs < base ? `evicted${abs}` : textOf(abs)));
			invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
				if (cmd !== "terminal_styled_rows") return undefined;
				return styledRange(args.start ?? 0, args.count ?? 0, base + CAP + ROWS, CAP, textOf, base);
			});
			paintGrid.mockClear();
			layOutPane();
			const view = render(() => <CanvasTerminal sessionId="scroll-1264-cap-live" terminalId="scroll-1264-cap-live" />);
			try {
				await waitFor(() => expect(frameSink.current).not.toBeNull());
				frameSink.current?.(fullFrame({ historySize: CAP, historyBase: base, displayOffset: 0, textOf }));
				const canvas = view.container.querySelector('canvas[tabindex="0"]');
				if (!canvas) throw new Error("terminal canvas not mounted");

				wheel(canvas, -80);
				await waitFor(() => expect(sentOffsets().length).toBe(1));
				const firstOffset = sentOffsets()[0];
				await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("terminal_styled_rows"));
				await new Promise((r) => setTimeout(r, 20));

				committed = true;
				base = 1005;
				paintGrid.mockClear();
				frameSink.current?.(fullFrame({ historySize: CAP, historyBase: base, displayOffset: firstOffset + 5, textOf }));

				wheel(canvas, 40);
				await new Promise((r) => setTimeout(r, 150));

				expectEveryPaintIsARunOf(truth());
				expect(paintedLines()).toContain(`F${liveTop}`);
			} finally {
				view.unmount();
			}
		});
	});

	// A rewind removes rows the backend already sent: the resize-repaint dedupe
	// (`drop_newest_history`, `drop_history_before` in the alacritty fork) lowers
	// total_scrolled with history_base unchanged. Every row newer than the removed
	// ones moves down by the same count in the all-time space the cache is keyed by.
	describe("when the backend rewinds history mid-gesture", () => {
		/** Mount, show `historySize` lines at the bottom, start a gesture and let the band fetch land. */
		async function scrolledBack(id: string, historySize: number, textOf: (abs: number) => string) {
			paintGrid.mockClear();
			layOutPane();
			const view = render(() => <CanvasTerminal sessionId={id} terminalId={id} />);
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame({ historySize, displayOffset: 0, textOf }));
			const canvas = view.container.querySelector('canvas[tabindex="0"]');
			if (!canvas) throw new Error("terminal canvas not mounted");
			wheel(canvas, -80);
			await waitFor(() => expect(sentOffsets().length).toBe(1));
			await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("terminal_styled_rows"));
			await new Promise((r) => setTimeout(r, 20));
			return { view, canvas, offset: sentOffsets()[0] };
		}

		/**
		 * Keep the same gesture going up a few lines, so the cache is painted after the
		 * rewind over the removed rows too. A stale cache can otherwise paint the whole
		 * window shifted by the same count, which is still a run of real lines.
		 */
		async function keepScrolling(canvas: Element) {
			for (let i = 0; i < 4; i++) {
				wheel(canvas, -60);
				await new Promise((r) => setTimeout(r, 30));
			}
			await new Promise((r) => setTimeout(r, 100));
		}

		// Physical lines P0..P103: 100 history lines, then the screen. The dedupe
		// removes P90..P92, the 3 rows just before the 7 newest history rows
		// (`drop_history_before(7, 3)`), so P93 moves from all-time row 93 to 90.
		const removedInside = (rewound: () => boolean) => (abs: number) => `P${!rewound() || abs < 90 ? abs : abs + 3}`;
		const insideOffset = (offset: number) => (offset > 7 ? Math.max(offset - 3, 7) : offset);

		// catches: negative history growth is ignored, so rows cached before the
		// rewind keep their old all-time keys: the gesture paints the removed
		// duplicates and misses the last 3 lines of the newer block — a contiguous
		// block missing in the middle of history.
		it("paints history without the removed rows and without a gap", async () => {
			let rewound = false;
			const textOf = removedInside(() => rewound);
			const historySize = () => (rewound ? 97 : 100);
			invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
				if (cmd !== "terminal_styled_rows") return undefined;
				return styledRange(args.start ?? 0, args.count ?? 0, historySize() + ROWS, historySize(), textOf);
			});
			const { view, canvas, offset } = await scrolledBack("rewind-inside", 100, textOf);
			try {
				rewound = true;
				paintGrid.mockClear();
				frameSink.current?.(fullFrame({ historySize: 97, displayOffset: insideOffset(offset), textOf }));
				await keepScrolling(canvas);

				expectEveryPaintIsARunOf(Array.from({ length: 97 + ROWS }, (_, abs) => textOf(abs)));
				// The window reached the rows just above the removed ones.
				expect(paintedLines()).toContain("P89");
			} finally {
				view.unmount();
			}
		});

		// catches: the same ignored rewind when the dedupe drops the NEWEST history
		// rows (`drop_newest_history(3)`): the screen moves up into their all-time
		// rows, and the live rows cached at the old screen position paint the
		// screen's first lines a second time below it.
		it("paints the screen once after the newest history rows are dropped", async () => {
			let rewound = false;
			// History P0..P96, then copies of the screen's first 3 lines, then the screen S0..S3.
			const screenTop = () => (rewound ? 97 : 100);
			const textOf = (abs: number) =>
				abs < 97 ? `P${abs}` : abs < screenTop() ? `S${abs - 97}` : `S${abs - screenTop()}`;
			invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
				if (cmd !== "terminal_styled_rows") return undefined;
				return styledRange(args.start ?? 0, args.count ?? 0, screenTop() + ROWS, screenTop(), textOf);
			});
			const { view, canvas, offset } = await scrolledBack("rewind-newest", 100, textOf);
			try {
				rewound = true;
				paintGrid.mockClear();
				frameSink.current?.(fullFrame({ historySize: 97, displayOffset: Math.max(0, offset - 3), textOf }));
				await keepScrolling(canvas);

				expectEveryPaintIsARunOf(Array.from({ length: 97 + ROWS }, (_, abs) => textOf(abs)));
				expect(paintGrid).toHaveBeenCalled();
			} finally {
				view.unmount();
			}
		});

		// catches: a fix that drops the cached rows but lets a chunk fetched before
		// the rewind land afterwards: it installs the pre-rewind rows at their old keys.
		it("discards a chunk that was fetched before the rewind and answers after it", async () => {
			let rewound = false;
			const textOf = removedInside(() => rewound);
			const historySize = () => (rewound ? 97 : 100);
			const held: Array<() => void> = [];
			invoke.mockImplementation(async (cmd: string, args: { start?: number; count?: number }) => {
				if (cmd !== "terminal_styled_rows") return undefined;
				// Read the rows now; deliver them only once the rewind frame is in.
				const answer = styledRange(args.start ?? 0, args.count ?? 0, historySize() + ROWS, historySize(), textOf);
				if (rewound) return answer;
				return new Promise((resolve) => held.push(() => resolve(answer)));
			});
			const { view, canvas, offset } = await scrolledBack("rewind-in-flight", 100, textOf);
			try {
				expect(held.length).toBeGreaterThan(0);
				rewound = true;
				paintGrid.mockClear();
				frameSink.current?.(fullFrame({ historySize: 97, displayOffset: insideOffset(offset), textOf }));
				for (const release of held.splice(0)) release();
				await keepScrolling(canvas);

				expectEveryPaintIsARunOf(Array.from({ length: 97 + ROWS }, (_, abs) => textOf(abs)));
				expect(paintedLines()).toContain("P89");
			} finally {
				view.unmount();
			}
		});
	});
});
