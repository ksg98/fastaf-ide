import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

/**
 * Copy-on-select keeps the highlight (#1534-66ac).
 *
 * Oracle: after mouse-up copies a selection that crosses a soft-wrapped line, the
 * backend answers with the UNWRAPPED text (differs from the row-joined text on
 * screen). The next full-replace frame carries identical rows, so the user's
 * highlight must still be painted.
 */

const { invoke, frameSink, fills } = vi.hoisted(() => ({
	invoke: vi.fn(),
	frameSink: { current: null as ((data: ArrayBuffer) => void) | null },
	fills: { styles: [] as string[], paints: [] as { rows: Map<number, DecodedRow>; projection: ViewportProjection }[] },
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
	createGridRenderer: () => ({
		setTheme: vi.fn(),
		invalidateCaches: vi.fn(),
		paintGrid: (rows: Map<number, DecodedRow>, _metrics: unknown, options: { projection: ViewportProjection }) => {
			fills.paints.push({ rows: new Map(rows), projection: options.projection });
		},
		paintRow: vi.fn(),
	}),
}));
vi.mock("../../utils/clipboard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/clipboard")>()),
	writeClipboard: vi.fn().mockResolvedValue(undefined),
}));

import capture from "../../components/Terminal/__tests__/fixtures/claude-suggest-1935.json";
import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { type DecodedRow, decodeStyledRange, rowText } from "../../components/Terminal/canvasTerminalUtils";
import type { ViewportProjection } from "../../components/Terminal/viewportProjection";
import { terminalsStore } from "../../stores/terminals";
import { writeClipboard } from "../../utils/clipboard";

const range = decodeStyledRange(Uint8Array.from(atob(capture.base64), (c) => c.charCodeAt(0)).buffer)!;
// Preserve recorded cell bytes and wrap flags; only adapt styled-range row headers
// into the full-frame wire envelope consumed by the mounted terminal.
function fullFrame(): ArrayBuffer {
	const source = Uint8Array.from(atob(capture.base64), (c) => c.charCodeAt(0));
	const payload = new Uint8Array(range.rows.length * (4 + range.cols * 11));
	const data = new DataView(payload.buffer);
	let offset = 0;
	let sourceOffset = 12;
	for (let index = 0; index < range.rows.length; index++) {
		data.setUint16(offset, index, true);
		payload.set(source.subarray(sourceOffset + 4, sourceOffset + 6 + range.cols * 11), offset + 2);
		offset += 4 + range.cols * 11;
		sourceOffset += 6 + range.cols * 11;
	}
	const bytes = new Uint8Array(26 + payload.length);
	bytes.set(payload, 26);
	const header = new DataView(bytes.buffer);
	header.setUint16(0, range.rows.length, true);
	header.setUint8(6, 1);
	header.setUint16(18, range.rows.length, true);
	header.setUint16(20, range.cols, true);
	header.setUint32(22, capture.start, true);
	return bytes.buffer;
}

describe("recorded Claude suggest projection and copy", () => {
	beforeEach(() => {
		invoke.mockReset();
		invoke.mockImplementation(async (cmd: string, args: Record<string, number> & { candidates?: string[] }) => {
			if (cmd === "resolve_terminal_paths") return args.candidates!.map(() => false);
			if (cmd === "terminal_styled_rows") return Uint8Array.from(atob(capture.base64), (c) => c.charCodeAt(0)).buffer;
			if (cmd === "terminal_get_selection_text") {
				return range.rows
					.slice(args.startRow, args.endRow + 1)
					.map(({ row }) => rowText(row).trimEnd())
					.join("\n");
			}
		});
		fills.paints = [];
		vi.mocked(writeClipboard).mockClear();
		fills.styles = [];
		frameSink.current = null;
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
		});
		let style = "";
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			new Proxy(
				{},
				{
					set: (_t, prop, value) => {
						if (prop === "fillStyle") style = String(value);
						return true;
					},
					get: (_t, prop) => {
						if (prop === "measureText")
							return () => ({ width: 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 });
						if (prop === "fillRect") return () => fills.styles.push(style);
						return vi.fn();
					},
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
		vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
		for (const name of ["ResizeObserver"]) {
			vi.stubGlobal(
				name,
				class {
					observe() {}
					disconnect() {}
				},
			);
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// Catches: rendering omits a suggestion but selection copies the unprojected backend range.
	it("omits captured row 5380 from painted rows and copied turn text", async () => {
		const terminalId = terminalsStore.add({
			sessionId: "suggest-1935",
			name: "Recorded Claude",
			cwd: null,
			fontSize: 14,
			awaitingInput: null,
		});
		const view = render(() => <CanvasTerminal sessionId="suggest-1935" terminalId={terminalId} />);
		try {
			await waitFor(() => expect(frameSink.current).not.toBeNull());
			frameSink.current?.(fullFrame());
			await waitFor(() => expect(fills.paints.length).toBeGreaterThan(0));
			const painted = fills.paints.at(-1)!;
			const projected = [...painted.rows.values()].flatMap((row) => {
				const visible = painted.projection.projectRow(row);
				return visible ? [rowText(visible)] : [];
			});
			expect(rowText(painted.rows.get(10)!)).toContain("suggest: [ Stato perf-frames");
			expect(painted.projection.displayRow(10)).toBeNull();
			expect(painted.projection.displayRow(12)).toBe(10);
			expect(projected.join("\n")).not.toContain("suggest:");
			const canvas = view.container.querySelector('canvas[tabindex="0"]')!;
			canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 8, clientY: 110, bubbles: true }));
			document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 260, bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 50));
			document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400, clientY: 260, bubbles: true }));
			await waitFor(() => expect(writeClipboard).toHaveBeenCalled());
			expect(vi.mocked(writeClipboard).mock.calls.at(-1)![0]).not.toContain("suggest:");
		} finally {
			view.unmount();
			terminalsStore.remove(terminalId);
		}
	});
});
