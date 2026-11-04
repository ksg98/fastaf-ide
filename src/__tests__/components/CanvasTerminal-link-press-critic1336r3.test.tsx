import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * Round 3: the context menu of a hover-only link opens from the hover. A left press on an underlined path while the app reports the mouse (Claude
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
import { terminalsStore } from "../../stores/terminals";

const ROWS = 2;
const COLS = 30;
const HEADER_SIZE = 26;
const CELL_SIZE = 11;
const GUTTER = 6;
const CELL_W = 8;
const ROW0 = "  followups.md  plain words";
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

describe("CanvasTerminal link press, critic 1336 round 3", () => {
	const onOpen = vi.fn();
	let screenRow0 = ROW0;
	let screenRow1 = "";
	let lateFileExists = false;
	let osc8Active = false;
	let osc8Target = "followups.md";
	let agentType: string | null = "claude";
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
		agentType = "claude";
		const realGet = terminalsStore.get.bind(terminalsStore);
		vi.spyOn(terminalsStore, "get").mockImplementation((id: string) =>
			id === "link-1336r3" ? ({ agentType, commandBlocks: [], foldedBlocks: [] } as never) : realGet(id),
		);
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
			<CanvasTerminal sessionId="link-1336r3" terminalId="link-1336r3" onOpenFilePath={onOpen} />
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

	const clickMenuItem = (label: string) => {
		const el = Array.from(document.body.querySelectorAll("*")).find(
			(n) => n.children.length === 0 && n.textContent?.trim() === label,
		) as HTMLElement | undefined;
		if (!el) throw new Error(`menu item ${label} not rendered`);
		el.click();
	};

	// Catches: the menu serving the target the hover resolved earlier, so Open after the hyperlink
	// target changed (same visible text) opens a link that is no longer under the pointer.
	it("Open from a hover-only link menu opens the target under the pointer now", async () => {
		await hoverOsc8();
		osc8Target = "other.md";
		const ev = contextMenu(OSC8_COL);
		expect(ev.defaultPrevented).toBe(true);
		await waitFor(() => expect(document.body.textContent ?? "").toContain("Copy link"));
		clickMenuItem("Open");
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/other.md", undefined, undefined));
		expect(onOpen).not.toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined);
	});

	// Catches: starting against the focused tab instead of the terminal that owns the link,
	// or toggling an already-armed mode off instead of navigating to this URL.
	it.each(["http://localhost:5173/page?x=1#target", "https://example.com/page"])(
		"starts Design Mode with the resolved link and owning terminal: %s",
		async (url) => {
			await hoverOsc8();
			osc8Target = url;
			contextMenu(OSC8_COL);
			await waitFor(() => expect(document.body.textContent ?? "").toContain("Start in Design Mode"));
			const parent = Array.from(document.body.querySelectorAll(".item")).find((node) =>
				node.textContent?.includes("Start in Design Mode"),
			);
			(parent as HTMLElement)?.click();
			await waitFor(() => expect(document.body.textContent ?? "").toContain("Edge"));
			clickMenuItem("Edge");
			await waitFor(() =>
				expect(invoke).toHaveBeenCalledWith("start_design_mode", { sessionId: "link-1336r3", browser: "edge", url }),
			);
			expect(invoke).not.toHaveBeenCalledWith("stop_design_mode", expect.anything());
		},
	);

	// Catches: offering a Design Mode start on a plain shell, where it always fails with
	// "Session is not running an agent".
	it("does not offer Design Mode on a terminal without an agent", async () => {
		agentType = null;
		await hoverOsc8();
		osc8Target = "http://localhost:5173/";
		contextMenu(OSC8_COL);
		await waitFor(() => expect(document.body.textContent ?? "").toContain("Copy link"));
		expect(document.body.textContent ?? "").not.toContain("Start in Design Mode");
	});

	// Catches: offering browser inspection for a file/custom-scheme terminal link.
	it.each(["followups.md", "file:///tmp/followups.md", "ftp://example.com/file"])(
		"does not offer Design Mode for non-web link: %s",
		async (url) => {
			await hoverOsc8();
			osc8Target = url;
			contextMenu(OSC8_COL);
			await waitFor(() => expect(document.body.textContent ?? "").toContain("Copy link"));
			expect(document.body.textContent ?? "").not.toContain("Start in Design Mode");
		},
	);

	// Catches: the hover-only menu opening but its Open item wired to nothing (menu target unset).
	it("Open from a hover-only link menu opens the hovered link", async () => {
		await hoverOsc8();
		contextMenu(OSC8_COL);
		await waitFor(() => expect(document.body.textContent ?? "").toContain("Copy link"));
		clickMenuItem("Open");
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined));
	});

	// Catches: the hover branch firing for a cell outside the hovered link, so a right press next to
	// the link steals the app's default menu / opens a link menu for a link not under the pointer.
	it("leaves the default menu alone on a right press next to a hovered link", async () => {
		await hoverOsc8();
		const ev = contextMenu(OSC8_COL + 3);
		await new Promise((r) => setTimeout(r, 50));
		expect(ev.defaultPrevented).toBe(false);
		expect(document.body.textContent ?? "").not.toContain("Copy link");
	});

	// Catches: a hover claim surviving an in-place redraw of its text, so the menu of a link that is
	// no longer on screen opens from the stale hover.
	it("leaves the default menu alone once the hovered text was redrawn in place", async () => {
		await hoverOsc8();
		screenRow0 = "  see xyz  plain words";
		send(frame("  see xyz  plain words", 2));
		await new Promise((r) => setTimeout(r, 20));
		const ev = contextMenu(OSC8_COL);
		await new Promise((r) => setTimeout(r, 50));
		expect(document.body.textContent ?? "").not.toContain("Copy link");
		expect(ev.defaultPrevented).toBe(false);
	});

	// Catches: the default menu being suppressed asynchronously (after the probe) for a hover-only
	// link: preventDefault must already be set when the handler's synchronous part returns.
	it("suppresses the default menu synchronously for a hover-only link", async () => {
		await hoverOsc8();
		const ev = contextMenu(OSC8_COL);
		expect(ev.defaultPrevented).toBe(true);
	});
});
