import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * Critic round 2 for #1324-015a: the press tracker against a drag-select ending
 * on a path, a press while the screen redraws under the pointer, a probe that
 * supersedes the click's own link check, a leftover selection, and mouse
 * reporting off. Oracle: what the user sees underlined at the press is what
 * opens at the release; nothing else opens.
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
const FIRST = "  followups.md  plain words";
const SECOND = "  otherfile.md  plain words";
/** Both names occupy columns 2-13 of row 0. */
const NAME_COL = 5;
const OTHER_COL = 20;

/** A full screen whose row 0 is `text`; `mouseMode` 0 is a plain shell, 2 is button-event tracking with SGR. */
function frame(text: string, mouseMode: 0 | 2): ArrayBuffer {
	const buffer = new ArrayBuffer(HEADER_SIZE + ROWS * (4 + COLS * CELL_SIZE));
	const view = new DataView(buffer);
	view.setUint16(0, ROWS, true);
	view.setUint8(6, 1);
	view.setUint8(17, mouseMode === 0 ? 0 : (2 << 3) | 0x20);
	view.setUint16(18, ROWS, true);
	view.setUint16(20, COLS, true);
	let offset = HEADER_SIZE;
	for (let r = 0; r < ROWS; r++) {
		view.setUint16(offset, r, true);
		view.setUint16(offset + 2, COLS, true);
		offset += 4;
		for (const char of (r === 0 ? text : "").padEnd(COLS, " ")) {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CanvasTerminal link press tracker (critic round 2)", () => {
	const onOpen = vi.fn();
	let canvas: Element;
	let unmount: () => void;
	let rowText = FIRST;
	let hyperlinkDelayMs = 0;

	async function mount(mouseMode: 0 | 2) {
		onOpen.mockClear();
		invoke.mockReset();
		rowText = FIRST;
		hyperlinkDelayMs = 0;
		invoke.mockImplementation(async (cmd: string, args: { candidate?: string; candidates?: string[] }) => {
			if (cmd === "terminal_hyperlink_span") {
				if (hyperlinkDelayMs) await sleep(hyperlinkDelayMs);
				return null;
			}
			if (cmd === "terminal_get_row_text") return rowText.trimEnd();
			if (cmd === "terminal_get_logical_line") return [0, rowText.trimEnd()];
			const resolve = (candidate: string) => {
				const c = candidate.replace(/^\/cwd\//, "");
				return c.startsWith("followups") || c.startsWith("otherfile")
					? { absolute_path: `/cwd/${c}`, is_directory: false }
					: null;
			};
			if (cmd === "resolve_terminal_path") return resolve(args.candidate ?? "");
			if (cmd === "resolve_terminal_paths") return (args.candidates ?? []).map(resolve);
			return null;
		});
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
			<CanvasTerminal sessionId="link-1324c" terminalId="link-1324c" onOpenFilePath={onOpen} />
		));
		unmount = view.unmount;
		await waitFor(() => expect(frameSink.current).not.toBeNull());
		// The reset above narrows `current` to null for the compiler; the subscribe mock refills it.
		(frameSink.current as ((data: ArrayBuffer) => void) | null)?.(frame(FIRST, mouseMode));
		const found = view.container.querySelector('canvas[tabindex="0"]');
		if (!found) throw new Error("terminal canvas not mounted");
		canvas = found;
		await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("resolve_terminal_paths"));
		await sleep(20);
		invoke.mockClear();
	}

	afterEach(() => {
		unmount();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	describe("mouse reporting on", () => {
		beforeEach(() => mount(2));

		// Catches: the release opening whatever is under the pointer NOW when the screen
		// redrew between press and release (aligned list rows, streaming agent output),
		// because the claim keeps only columns, not which link was pressed.
		it("does not open a different path that scrolled under a held press", async () => {
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			rowText = SECOND;
			frameSink.current?.(frame(SECOND, 2));
			await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("resolve_terminal_paths"));
			await sleep(20);
			fire(canvas, "mouseup", NAME_COL);
			fire(canvas, "click", NAME_COL);
			await sleep(200);
			expect(onOpen).not.toHaveBeenCalledWith("/cwd/otherfile.md", undefined, undefined);
		});

		// Catches: the click's own link check being superseded by the 100 ms hover probe a
		// press-time jitter scheduled, leaving hoveredLink null and the click silently dropped
		// after the press was already withheld from the app.
		it("still opens when a hover probe supersedes the click's link check", async () => {
			hyperlinkDelayMs = 60;
			fire(document.body, "mousemove", NAME_COL, { buttons: 0 }); // probe due at +100 ms
			await sleep(60);
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			fire(canvas, "mouseup", NAME_COL);
			fire(canvas, "click", NAME_COL); // its check runs 60..120 ms; the probe starts at 100 ms
			await sleep(400);
			await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined));
		});

		// Catches: a leftover Shift-drag selection making every later link click dead,
		// because a plain press under mouse reporting never clears it and click bails on hasRange().
		it("opens a link after a Shift-drag selection elsewhere", async () => {
			fire(canvas, "mousedown", OTHER_COL, { buttons: 1, shiftKey: true });
			fire(document.body, "mousemove", OTHER_COL + 4, { buttons: 1, shiftKey: true });
			await sleep(50);
			fire(document.body, "mouseup", OTHER_COL + 4, { shiftKey: true });
			await sleep(20);
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			fire(canvas, "mouseup", NAME_COL);
			fire(canvas, "click", NAME_COL);
			await sleep(300);
			await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined));
		});

		// Catches: a claim that outlives a release outside the canvas (no click ever fires)
		// and swallows the next app-owned press's drag reports.
		it("reports the drag of an app-owned press after a claimed press was released outside", () => {
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			fire(document.body, "mouseup", 0, { clientX: 5000 } as MouseEventInit);
			fire(canvas, "mousedown", OTHER_COL, { buttons: 1 });
			fire(document.body, "mousemove", OTHER_COL + 1, { buttons: 1 });
			const writes = invoke.mock.calls
				.filter(([cmd]) => cmd === "write_pty")
				.map(([, a]) => (a as { data: string }).data);
			expect(writes.some((d) => /^\x1b\[<32;/.test(d))).toBe(true);
		});
	});

	describe("mouse reporting off (plain shell)", () => {
		beforeEach(() => mount(0));

		// Catches: the plain-shell click regressing when the tracker replaced the hover read.
		it("opens an underlined name on a plain click", async () => {
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			fire(canvas, "mouseup", NAME_COL);
			fire(canvas, "click", NAME_COL);
			await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/cwd/followups.md", undefined, undefined));
		});

		// Catches: a text drag-select that ends on a path opening the file.
		it("does not open a path where a drag-select ended", async () => {
			fire(canvas, "mousedown", OTHER_COL, { buttons: 1 });
			fire(document.body, "mousemove", NAME_COL, { buttons: 1 });
			await sleep(50);
			fire(document.body, "mouseup", NAME_COL);
			fire(canvas, "click", NAME_COL);
			await sleep(300);
			expect(onOpen).not.toHaveBeenCalled();
		});

		// Catches: a drag that starts on a path and selects text opening the path on release.
		it("does not open when a press on a path turned into a selection", async () => {
			fire(canvas, "mousedown", NAME_COL, { buttons: 1 });
			fire(document.body, "mousemove", NAME_COL + 4, { buttons: 1 });
			await sleep(50);
			fire(document.body, "mouseup", NAME_COL + 4);
			fire(canvas, "click", NAME_COL + 4);
			await sleep(300);
			expect(onOpen).not.toHaveBeenCalled();
		});
	});
});
