import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * #1336-7755: a relative path with directory segments, printed by an agent and resolved against
 * the session cwd, must open on a plain click — with and without mouse reporting. The resolver
 * fake answers only for the session's own cwd, so a click that resolved against the wrong base
 * (or never resolved) cannot produce the absolute path.
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
import { isPerfDebug, setPerfDebug } from "../../utils/perfDebug";

const ROWS = 2;
const COLS = 60;
const HEADER_SIZE = 26;
const CELL_SIZE = 11;
const GUTTER = 6;
const CELL_W = 8;
const SESSION_CWD = "/work/session";
const REL = "work/business-review/Q3-FEATURES-REVIEW.md";
// A sentence period must not become part of the filesystem candidate (#2372).
const ROW0 = `  ${REL}. plain words`;
/** Inside the path, past the first directory segment. */
const PATH_COL = 12;
const OTHER_COL = 50;

function frame(mouseMode: number): ArrayBuffer {
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
		for (const char of (r === 0 ? ROW0 : "").padEnd(COLS, " ")) {
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

function click(target: Element, col: number) {
	fire(target, "mousedown", col, { buttons: 1 });
	fire(target, "mouseup", col);
	fire(target, "click", col);
}

const ptyWrites = () =>
	invoke.mock.calls.filter(([cmd]) => cmd === "write_pty").map(([, a]) => (a as { data: string }).data);

describe.each([
	["without mouse reporting", 0],
	["under mouse reporting (?1000/1002/1006)", 2],
])("relative path click %s", (_label, mouseMode) => {
	const onOpen = vi.fn();
	let canvas: Element;
	let unmount: () => void;
	let perfDebug: boolean;

	beforeEach(async () => {
		perfDebug = isPerfDebug();
		setPerfDebug(false);
		onOpen.mockClear();
		invoke.mockReset();
		const resolve = (cwd: string, c: string) =>
			cwd === SESSION_CWD && (c === REL || c === `${cwd}/${REL}`)
				? { absolute_path: `${cwd}/${REL}`, is_directory: false }
				: null;
		invoke.mockImplementation(
			async (cmd: string, args: { cwd?: string; candidate?: string; candidates?: string[] }) => {
				if (cmd === "terminal_hyperlink_span") return null;
				if (cmd === "terminal_get_row_text") return ROW0.trimEnd();
				if (cmd === "terminal_get_logical_line") return [0, ROW0.trimEnd()];
				if (cmd === "resolve_terminal_path") return resolve(args.cwd ?? "", args.candidate ?? "");
				if (cmd === "resolve_terminal_paths") return (args.candidates ?? []).map((c) => resolve(args.cwd ?? "", c));
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

		const terminalId = terminalsStore.add({
			name: "t",
			sessionId: "rel-1336",
			fontSize: 14,
			cwd: SESSION_CWD,
			awaitingInput: null,
		});
		const view = render(() => <CanvasTerminal sessionId="rel-1336" terminalId={terminalId} onOpenFilePath={onOpen} />);
		unmount = view.unmount;
		await waitFor(() => expect(frameSink.current).not.toBeNull());
		(frameSink.current as ((data: ArrayBuffer) => void) | null)?.(frame(mouseMode));
		const found = view.container.querySelector('canvas[tabindex="0"]');
		if (!found) throw new Error("terminal canvas not mounted");
		canvas = found;
		await waitFor(() => expect(invoke.mock.calls.map(([c]) => c)).toContain("resolve_terminal_paths"));
		await new Promise((r) => setTimeout(r, 20));
		invoke.mockClear();
	});

	afterEach(() => {
		unmount();
		setPerfDebug(perfDebug);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// Catches: the click being claimed (press swallowed) or lost by the 1324 release-time lookup
	// without the open request being sent, for a multi-segment relative path.
	it("opens the file at the cwd-resolved absolute path and keeps the press from the app", async () => {
		click(canvas, PATH_COL);
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${SESSION_CWD}/${REL}`, undefined, undefined));
		expect(onOpen).toHaveBeenCalledTimes(1);
		if (mouseMode !== 0) expect(ptyWrites()).toEqual([]);
	});

	// Catches: the open being resolved against an empty or wrong cwd instead of the session's.
	it("resolves the click against the session cwd", async () => {
		click(canvas, PATH_COL);
		await waitFor(() => expect(onOpen).toHaveBeenCalled());
		const resolves = invoke.mock.calls.filter(([c]) => c === "resolve_terminal_path");
		expect(resolves.map(([, a]) => a)).toContainEqual({ cwd: SESSION_CWD, candidate: REL });
		for (const [, a] of resolves) expect(a).toMatchObject({ cwd: SESSION_CWD });
		expect(onOpen).toHaveBeenCalledWith(`${SESSION_CWD}/${REL}`, undefined, undefined);
	});

	// Catches: the open firing for a click beside the path.
	it("does not open when the click lands off the path", async () => {
		click(canvas, OTHER_COL);
		await new Promise((r) => setTimeout(r, 150));
		expect(onOpen).not.toHaveBeenCalled();
	});
});
