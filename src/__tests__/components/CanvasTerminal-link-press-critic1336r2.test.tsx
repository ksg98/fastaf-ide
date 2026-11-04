import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * A left press on an underlined path while the app reports the mouse (Claude
 * Code fullscreen). The contract is the user's: the underlined name opens when
 * clicked, every other press still belongs to the app. The last case is the same
 * contract without mouse reporting (Claude with the alternate screen disabled).
 */

const { invoke, frameSink } = vi.hoisted(() => ({
	invoke: vi.fn(),
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
	createGridRenderer: () => ({ setTheme: vi.fn(), invalidateCaches: vi.fn(), paintGrid: vi.fn(), paintRow: vi.fn() }),
}));

import CanvasTerminal from "../../components/Terminal/CanvasTerminal";

const ROWS = 2;
const COLS = 30;
const HEADER_SIZE = 26;
const CELL_SIZE = 11;
const GUTTER = 6;
const CELL_W = 8;
const ROW0 = "  followups.md  plain words";
const WRAP0 = "                  docs/followu";
const WRAP1 = "ps.md";
/** `followups.md` occupies columns 2-13 of row 0. */

/** Tagged by the app as an OSC 8 hyperlink to `followups.md`; the text itself is no path. Columns 6-8. */
const OSC8_ROW = "  see doc  plain words";
const OSC8_COL = 7;

/** A full screen whose row 0 is `row0`, with mouse reporting (SGR, button-event tracking) on unless `mouseMode` is 0. */
function frame(row0 = ROW0, mouseMode = 2): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + ROWS * (4 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, ROWS, true);
	view.setUint8(6, 1);
	view.setUint8(17, mouseMode === 0 ? 0 : (mouseMode << 3) | 0x20);
	view.setUint16(18, ROWS, true);
	view.setUint16(20, COLS, true);
	let offset = HEADER_SIZE;
	for (let r = 0; r < ROWS; r++) {
		view.setUint16(offset, r, true);
		view.setUint16(offset + 2, COLS, true);
		offset += 4;
		for (const char of (r === 0 ? row0 : "").padEnd(COLS, " ")) {
			view.setUint32(offset, char.codePointAt(0) ?? 0, true);
			offset += CELL_SIZE;
		}
	}
	return buffer;
}

const x = (col: number) => GUTTER + col * CELL_W + CELL_W / 2;

function fire(target: Element, type: string, col: number, init: MouseEventInit = {}) {
	target.dispatchEvent(
		new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x(col), clientY: 2, button: 0, ...init }),
	);
}

function click(target: Element, pressCol: number, releaseCol: number, init: MouseEventInit = {}) {
	fire(target, "mousedown", pressCol, { buttons: 1, ...init });
	fire(target, "mouseup", releaseCol, init);
	fire(target, "click", releaseCol, init);
}

const ptyWrites = () =>
	invoke.mock.calls.filter(([cmd]) => cmd === "write_pty").map(([, a]) => (a as { data: string }).data);

/** Like frame() but with an explicit second row and the wrapped flag on row 0. */
function frame2(row0: string, row1: string, mouseMode: 0 | 2, wrapped: boolean): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + ROWS * (4 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, ROWS, true);
	view.setUint8(6, 1);
	view.setUint8(17, mouseMode === 0 ? 0 : (mouseMode << 3) | 0x20);
	view.setUint16(18, ROWS, true);
	view.setUint16(20, COLS, true);
	let offset = HEADER_SIZE;
	for (let r = 0; r < ROWS; r++) {
		view.setUint16(offset, r, true);
		view.setUint16(offset + 2, COLS | (r === 0 && wrapped ? 0x8000 : 0), true);
		offset += 4;
		for (const char of (r === 0 ? row0 : row1).padEnd(COLS, " ")) {
			view.setUint32(offset, char.codePointAt(0) ?? 0, true);
			offset += CELL_SIZE;
		}
	}
	return buffer;
}

describe("CanvasTerminal link press, critic 1336 round 2", () => {
	const onOpen = vi.fn();
	let screenRow0 = ROW0;
	let screenRow1 = "";
	let lateFileExists = false;
	let osc8Active = false;
	let osc8Target = "followups.md";
	let canvas: Element;
	let unmount: () => void;

	beforeEach(async () => {
		onOpen.mockClear();
		invoke.mockReset();
		screenRow0 = ROW0;
		screenRow1 = "";
		lateFileExists = false;
		osc8Active = false;
		osc8Target = "followups.md";
		invoke.mockImplementation(
			async (cmd: string, args: { candidate?: string; candidates?: string[]; col?: number; row?: number }) => {
				if (cmd === "terminal_hyperlink_span") {
					const col = args.col ?? -1;
					return osc8Active && col >= 6 && col < 9 ? [6, 9, osc8Target] : null;
				}
				if (cmd === "terminal_get_row_text") return (args.row === 1 ? screenRow1 : screenRow0).trimEnd();
				if (cmd === "terminal_get_logical_line")
					return [0, screenRow1 ? (screenRow0.padEnd(COLS, " ") + screenRow1).trimEnd() : screenRow0.trimEnd()];
				const resolve = (candidate: string) => {
					const c = candidate.replace(/^\/cwd\//, "");
					return c.startsWith("followups") ||
						c.startsWith("other") ||
						c.startsWith("docs/followups") ||
						(c.startsWith("later") && lateFileExists)
						? { absolute_path: `/cwd/${c}`, is_directory: false }
						: null;
				};
				if (cmd === "resolve_terminal_path") return resolve(args.candidate ?? "");
				if (cmd === "resolve_terminal_paths") return (args.candidates ?? []).map(resolve);
				return null;
			},
		);
		frameSink.current = null;
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
		});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			new Proxy(
				{},
				{
					get: (_t, prop) =>
						prop === "measureText"
							? () => ({ width: CELL_W, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 })
							: vi.fn(),
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
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);

		const view = render(() => (
			<CanvasTerminal sessionId="link-1336r2" terminalId="link-1336r2" onOpenFilePath={onOpen} />
		));
		unmount = view.unmount;
		await waitFor(() => expect(frameSink.current).not.toBeNull());
		// The reset above narrows `current` to null for the compiler; the subscribe mock refills it.
		(frameSink.current as ((data: ArrayBuffer) => void) | null)?.(frame());
		const found = view.container.querySelector('canvas[tabindex="0"]');
		if (!found) throw new Error("terminal canvas not mounted");
		canvas = found;
		// The underline exists once verification has resolved the name.
		await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("resolve_terminal_paths"));
		await new Promise((r) => setTimeout(r, 20));
		invoke.mockClear();
	});

	afterEach(() => {
		unmount();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const send = (data: ArrayBuffer) => (frameSink.current as ((d: ArrayBuffer) => void) | null)?.(data);
	const hoverOsc8 = async () => {
		osc8Active = true;
		screenRow0 = OSC8_ROW;
		send(frame(OSC8_ROW, 2));
		await new Promise((r) => setTimeout(r, 20));
		fire(document.body, "mousemove", OSC8_COL);
		await waitFor(() => expect(canvas.getAttribute("style") ?? "").toContain("pointer"));
	};

	const contextMenu = (col: number) => {
		fire(canvas, "mousedown", col, { button: 2, buttons: 2 });
		const ev = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: x(col),
			clientY: 2,
			button: 2,
		});
		canvas.dispatchEvent(ev);
		return ev;
	};

	// Catches: the context menu keyed on the dashed underline only, so a hover-only (OSC 8) link
	// shows the default menu instead of Open / Copy link.
	it("opens the link menu on a right press over a hover-only link", async () => {
		await hoverOsc8();
		const ev = contextMenu(OSC8_COL);
		expect(ev.defaultPrevented).toBe(true);
		await waitFor(() => expect(document.body.textContent ?? "").toContain("Copy link"));
	});

	// Catches: a hover claim that outlives its link (target gone, same text) opening a menu for
	// the stale target. The default menu is suppressed synchronously, so no menu is the outcome.
	it("shows no link menu when the claimed link no longer resolves", async () => {
		await hoverOsc8();
		osc8Active = false;
		const ev = contextMenu(OSC8_COL);
		await new Promise((r) => setTimeout(r, 100));
		expect(ev.defaultPrevented).toBe(true);
		expect(document.body.textContent ?? "").not.toContain("Copy link");
	});

	// Catches: a click on text whose hyperlink target changed (same visible text) opening the
	// target the hover resolved earlier instead of what is under the pointer now.
	it("opens the target under the pointer at click time, not the one hovered earlier", async () => {
		await hoverOsc8();
		osc8Target = "other.md";
		click(canvas, OSC8_COL, OSC8_COL);
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/other.md", undefined, undefined));
		expect(onOpen).not.toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined);
	});

	// Catches: a middle press over a hover-only link being claimed or opening it; middle belongs to the app.
	it("forwards a middle press over a hover-only link to the app and opens nothing", async () => {
		await hoverOsc8();
		click(canvas, OSC8_COL, OSC8_COL, { button: 1 });
		await new Promise((r) => setTimeout(r, 100));
		expect(onOpen).not.toHaveBeenCalled();
		expect(ptyWrites().length).toBeGreaterThan(0);
	});

	// Catches: the signature covering only the span under the pointer (or only the first span), so
	// a redraw of the continuation row leaves a wrapped hover claiming a press on the first row.
	it("forwards the press when only the continuation row of a hovered wrapped path was redrawn", async () => {
		screenRow0 = WRAP0;
		screenRow1 = WRAP1;
		send(frame2(WRAP0, WRAP1, 2, true));
		await new Promise((r) => setTimeout(r, 20));
		const col = 22;
		fire(document.body, "mousemove", col);
		await waitFor(() => expect(canvas.getAttribute("style") ?? "").toContain("pointer"));
		screenRow1 = "zz.md";
		send(frame2(WRAP0, "zz.md", 2, true));
		await new Promise((r) => setTimeout(r, 20));
		invoke.mockClear();
		fire(canvas, "mousedown", col, { buttons: 1 });
		fire(canvas, "mouseup", col);
		await new Promise((r) => setTimeout(r, 100));
		expect(onOpen).not.toHaveBeenCalledWith("/cwd/docs/followups.md", undefined, undefined);
		expect(ptyWrites().length).toBeGreaterThan(0);
	});

	// Catches: the signature recorded as "" for a miss and compared as equal to the next miss, so a
	// press on a cell the hover never covered is claimed (the hover covers columns 6-8 only).
	it("forwards a press next to a hovered link, outside its cells", async () => {
		await hoverOsc8();
		click(canvas, OSC8_COL + 3, OSC8_COL + 3);
		await new Promise((r) => setTimeout(r, 100));
		expect(onOpen).not.toHaveBeenCalled();
		expect(ptyWrites().length).toBeGreaterThan(0);
	});
});
