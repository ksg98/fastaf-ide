import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * Round 4: the context menu re-resolves the link under the pointer. The re-resolution can be
 * superseded by a newer hover probe; the menu must then never serve a link from a different cell.
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
const COLS = 40;
const HEADER_SIZE = 26;
const CELL_SIZE = 11;
const GUTTER = 6;
const CELL_W = 8;
/** OSC 8 link "see doc" at columns 6-8 (target other.md); a plain path `followups.md` at columns 12-23. */
const ROW0 = "  see doc  followups.md  tail";
const OSC8_COL = 7;
const PATH_COL = 15;
/** How long the hyperlink probe takes over the path: longer than the 100 ms hover throttle. */
const SLOW_MS = 150;

function frame(row0: string): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + ROWS * (4 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, ROWS, true);
	view.setUint8(6, 1);
	view.setUint8(17, (2 << 3) | 0x20);
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

describe("CanvasTerminal link context menu, critic 1336 round 5", () => {
	const onOpen = vi.fn();
	let canvas: Element;
	let unmount: () => void;

	beforeEach(async () => {
		onOpen.mockClear();
		invoke.mockReset();
		invoke.mockImplementation(
			async (cmd: string, args: { candidate?: string; candidates?: string[]; col?: number }) => {
				if (cmd === "terminal_hyperlink_span") {
					const col = args.col ?? -1;
					if (col >= 6 && col < 9) return [6, 9, "other.md"];
					await new Promise((r) => setTimeout(r, SLOW_MS));
					return null;
				}
				if (cmd === "terminal_get_row_text") return ROW0.trimEnd();
				if (cmd === "terminal_get_logical_line") return [0, ROW0.trimEnd()];
				const resolve = (candidate: string) => {
					const c = candidate.replace(/^\/cwd\//, "");
					return c.startsWith("followups") || c.startsWith("other")
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
			<CanvasTerminal sessionId="link-1336r5" terminalId="link-1336r5" onOpenFilePath={onOpen} />
		));
		unmount = view.unmount;
		await waitFor(() => expect(frameSink.current).not.toBeNull());
		(frameSink.current as ((data: ArrayBuffer) => void) | null)?.(frame(ROW0));
		const found = view.container.querySelector('canvas[tabindex="0"]');
		if (!found) throw new Error("terminal canvas not mounted");
		canvas = found;
		await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("resolve_terminal_paths"));
		await new Promise((r) => setTimeout(r, 20));
		invoke.mockClear();
	});

	afterEach(() => {
		unmount();
		invoke.mockClear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const openItems = () =>
		Array.from(document.body.querySelectorAll("*")).filter(
			(n) => n.children.length === 0 && n.textContent?.trim() === "Open",
		) as HTMLElement[];
	const contextmenu = (col: number) =>
		canvas.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x(col), clientY: 2, button: 2 }),
		);

	// Catches: two overlapping right-clicks resolving out of order, so the menu serves the link of the
	// click the user made FIRST (its slow lookup finishes last and overwrites the target).
	it("opens the link of the latest right-click when an earlier slower lookup finishes after it", async () => {
		fire(document.body, "mousemove", OSC8_COL);
		await waitFor(() => expect(canvas.getAttribute("style") ?? "").toContain("pointer"));
		contextmenu(PATH_COL); // slow hyperlink probe (SLOW_MS)
		contextmenu(OSC8_COL); // fast: OSC 8 answers at once
		await new Promise((r) => setTimeout(r, SLOW_MS * 3));
		for (const el of openItems()) el.click();
		await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/other.md", undefined, undefined));
	});

	// Catches: a lookup that resolves after the user dismissed the intent (left click elsewhere) and
	// pops a menu up out of nowhere.
	it("does not pop a menu up after the user left-clicked elsewhere while the lookup ran", async () => {
		contextmenu(PATH_COL);
		fire(canvas, "mousedown", 30, { button: 0 });
		fire(document.body, "mouseup", 30, { button: 0 });
		await new Promise((r) => setTimeout(r, SLOW_MS * 3));
		expect(openItems()).toHaveLength(0);
	});
});
