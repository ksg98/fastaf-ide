import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { setPerfDebug } from "../../../utils/perfDebug";
import type { CellMetrics, DecodedRow } from "../canvasTerminalUtils";
import {
	dumpFrameWorkload,
	FrameWorkloadRecorder,
	type PaintState,
	recordWorkloadArrival,
	recordWorkloadPaint,
	setFrameWorkloadEnabled,
} from "../frameWorkload";
import { type RecordedRow, replayFrameWorkload, restoreWorkloadRow } from "../frameWorkloadReplay";

const metrics: CellMetrics = {
	cellWidth: 8,
	cellHeight: 16,
	baseline: 12,
	fontSize: 14,
	dpr: 2,
	scaledCellWidth: 16,
	scaledCellHeight: 32,
};
const state: PaintState = {
	metrics,
	fontFamily: "monospace",
	fontWeight: 400,
	width: 640,
	height: 128,
	background: "#000000",
	foreground: "#ffffff",
	neutral: "#000000",
	hidden: false,
	fullRepaint: true,
	projectionChanged: false,
	hiddenRows: [],
	answerMarkers: [],
};
function row(index = 0, count = 3): DecodedRow {
	return {
		index,
		count,
		wrapped: false,
		codepoints: new Uint32Array(count).fill(65),
		fg: new Uint32Array(count).fill(0xffffff),
		bg: new Uint32Array(count),
		attrs: new Uint8Array(count),
		cellExtras: new Map([[0, "\u0301"]]),
	};
}
afterEach(() => {
	setFrameWorkloadEnabled(false);
	vi.restoreAllMocks();
});

it("eviction retains newest complete paint instead of losing the partial-frame merge baseline", () => {
	const recorder = new FrameWorkloadRecorder(4096, 2);
	const rows = new Map([[0, row()]]);
	recorder.paint("terminal", rows, state, 0);
	rows.set(0, { ...row(), codepoints: new Uint32Array([0x1f600, 0, 66]) });
	recorder.arrival("terminal", new Uint8Array([1, 2, 3]).buffer, false, 1);
	recorder.paint("terminal", rows, { ...state, fullRepaint: false, dirtyIndices: [0] }, 2);
	rows.clear();
	const recording = recorder.snapshot("test", 2);
	expect(recording.events).toHaveLength(2);
	expect(recording.dropped).toBe(1);
	const paint = recording.events[1] as { rows: RecordedRow[]; state: PaintState };
	expect([...restoreWorkloadRow(paint.rows[0]).codepoints]).toEqual([0x1f600, 0, 66]);
	expect(restoreWorkloadRow(paint.rows[0]).cellExtras?.get(0)).toBe("\u0301");
	expect(paint.state.dirtyIndices).toEqual([0]);
});
it("global event and byte caps prevent many-terminal pressure from growing memory", () => {
	const recorder = new FrameWorkloadRecorder(2048, 3);
	for (let i = 0; i < 20; i++) recorder.arrival(`terminal-${i}`, new ArrayBuffer(512), i % 2 === 0, i);
	expect(recorder.status().events).toBeLessThanOrEqual(3);
	expect(recorder.status().bytes).toBeLessThanOrEqual(2048);
	expect(recorder.status().dropped).toBeGreaterThan(0);
	const before = recorder.status().events;
	recorder.arrival("oversized", new ArrayBuffer(4096), false, 21);
	expect(recorder.status().events).toBe(before);
	recorder.arrival("new-window", new ArrayBuffer(32), false, 20_000);
	expect(recorder.snapshot("expired", 20_000).events).toHaveLength(1);
});
it("binary retention copies input so later transport reuse cannot corrupt evidence", () => {
	const recorder = new FrameWorkloadRecorder();
	const buffer = new Uint8Array([0, 1, 255]);
	recorder.arrival("terminal", buffer.buffer, true, 1);
	buffer.fill(99);
	expect(recorder.snapshot("test", 1).events[0]).toMatchObject({ binary: "AAH/", hidden: true });
});
it("disabled recorder and disabled master gate do not copy or encode per-frame bytes", () => {
	setPerfDebug(true);
	const copy = vi.spyOn(ArrayBuffer.prototype, "slice");
	recordWorkloadArrival("terminal", new ArrayBuffer(32), false);
	setFrameWorkloadEnabled(true);
	setPerfDebug(false);
	recordWorkloadArrival("terminal", new ArrayBuffer(32), false);
	expect(copy).not.toHaveBeenCalled();
});
it("synthetic smoke reaches production text paint with font DPR and projection state, not a stall RED", async () => {
	const recording = JSON.parse(
		readFileSync("src/components/Terminal/__tests__/fixtures/frame-workload-smoke.json", "utf8"),
	);
	const fillText = vi.fn();
	const canvas = { width: 640, height: 128, getContext: () => ctx };
	const ctx = { canvas, fillText, fillRect: vi.fn(), setTransform: vi.fn() };
	const result = await replayFrameWorkload(recording, () => canvas as unknown as HTMLCanvasElement);
	expect(fillText).toHaveBeenCalledWith("A\u0301", expect.any(Number), expect.any(Number));
	expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, expect.any(Number), 0);
	expect(result.frames).toHaveLength(1);
	expect(result.source).toBe("synthetic-smoke-not-stall-red");
});

it("a stall longer than the window does not erase its last paint before the dump", () => {
	const recorder = new FrameWorkloadRecorder();
	recorder.paint("stalled", new Map([[0, row()]]), state, 10);
	expect(recorder.snapshot("recovered-after-long-paint", 60_000).events).toHaveLength(1);
});

it("a queued dump retains the triggering slow paint when a later arrival ages the active window", async () => {
	vi.useFakeTimers();
	let now = 10;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const invoke = vi.fn().mockResolvedValue("capture.json");
	vi.doMock("../../../invoke", () => ({ invoke }));
	try {
		setPerfDebug(true);
		setFrameWorkloadEnabled(true);
		recordWorkloadPaint("stalled", new Map([[0, row()]]), state);
		// The paint consumed 31 seconds. Dumping yields to the event loop;
		// an already queued transport delivery can run before that timer.
		now = 31_010;
		const pending = dumpFrameWorkload("long-grid-paint");
		recordWorkloadArrival("stalled", new ArrayBuffer(32), false);
		await vi.runAllTimersAsync();
		await pending;
		const recording = JSON.parse(invoke.mock.calls[0][1].recording);
		expect(recording.events.some((event: { kind: string }) => event.kind === "paint")).toBe(true);
	} finally {
		vi.doUnmock("../../../invoke");
		vi.useRealTimers();
	}
});
