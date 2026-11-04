/** Grid-paint replay only: no invented heartbeat/IPC/input continuity assertions. */
// DEFERRED (2026-10-17) — native WebKit heartbeat/input replay needs a real captured
// stall; the labelled synthetic smoke cannot prove frontend liveness.
import { type DecodedRow, GUTTER_PX } from "./canvasTerminalUtils";
import { type PaintState, WORKLOAD_FILE_BYTES, type WorkloadRecording } from "./frameWorkload";
import { createGridRenderer } from "./gridRenderer";
import { ViewportProjection } from "./viewportProjection";

export interface RecordedRow {
	index: number;
	count: number;
	wrapped: boolean;
	codepoints: string;
	fg: string;
	bg: string;
	attrs: string;
	cellExtras: [number, string][];
}
function bytes(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
function u32(text: string): Uint32Array {
	const data = bytes(text);
	if (data.length % 4) throw new Error("invalid workload uint32 bytes");
	const view = new DataView(data.buffer);
	return Uint32Array.from({ length: data.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}
export function restoreWorkloadRow(row: RecordedRow): DecodedRow {
	const restored = {
		...row,
		codepoints: u32(row.codepoints),
		fg: u32(row.fg),
		bg: u32(row.bg),
		attrs: bytes(row.attrs),
		cellExtras: new Map(row.cellExtras),
	};
	if (
		[restored.codepoints.length, restored.fg.length, restored.bg.length, restored.attrs.length].some(
			(n) => n !== row.count,
		)
	)
		throw new Error("invalid workload row width");
	return restored;
}

/** Supply a dedicated canvas per session; never replay into a live terminal. Paint
 * times exclude font loading, decoding, pacing and canvas resize. No threshold
 * means PASS: a real recording still needs a native WebKit liveness harness. */
export async function replayFrameWorkload(
	recording: WorkloadRecording,
	canvasFor: (session: string) => HTMLCanvasElement,
	pace = false,
) {
	if (
		new TextEncoder().encode(JSON.stringify(recording)).length > WORKLOAD_FILE_BYTES ||
		recording.schema_version !== 1
	)
		throw new Error("unsupported/oversized workload");
	const results: { session: string; at: number; paint_ms: number; rows: number }[] = [];
	const renderers = new Map<
		string,
		{ canvas: HTMLCanvasElement; renderer: ReturnType<typeof createGridRenderer>; state: PaintState }
	>();
	let previousAt: number | undefined;
	for (const raw of recording.events) {
		const event = raw as { kind: string; session: string; at: number; rows: RecordedRow[]; state: PaintState };
		if (pace && previousAt !== undefined)
			await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(10_000, event.at - previousAt!))));
		previousAt = event.at;
		if (event.kind !== "paint") continue; // binary arrivals remain available for decode/merge investigation
		const state = event.state;
		await document.fonts?.load(`${state.fontWeight} ${state.metrics.fontSize}px ${state.fontFamily}`);
		let target = renderers.get(event.session);
		if (!target) {
			const canvas = canvasFor(event.session);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("2D canvas unavailable");
			target = {
				canvas,
				state,
				renderer: createGridRenderer(ctx, {
					fontWeight: () => renderers.get(event.session)!.state.fontWeight,
					getFontFamily: () => renderers.get(event.session)!.state.fontFamily,
				}),
			};
			renderers.set(event.session, target);
		}
		if (
			!Number.isInteger(state.width) ||
			!Number.isInteger(state.height) ||
			state.width < 1 ||
			state.height < 1 ||
			state.width > 16384 ||
			state.height > 16384 ||
			!(state.metrics.dpr > 0)
		)
			throw new Error("invalid workload canvas geometry");
		const previous = target.state;
		const fontChanged =
			previous.fontFamily !== state.fontFamily ||
			previous.fontWeight !== state.fontWeight ||
			previous.metrics.fontSize !== state.metrics.fontSize;
		target.state = state;
		if (target.canvas.width !== state.width) target.canvas.width = state.width;
		if (target.canvas.height !== state.height) target.canvas.height = state.height;
		target.canvas
			.getContext("2d")!
			.setTransform(state.metrics.dpr, 0, 0, state.metrics.dpr, GUTTER_PX * state.metrics.dpr, 0);
		if (fontChanged) target.renderer.invalidateCaches();
		target.renderer.setTheme(state.background, state.foreground, state.neutral);
		const rows = new Map(event.rows.map((row) => [row.index, restoreWorkloadRow(row)]));
		const options = {
			fullRepaint: state.fullRepaint,
			viewportTop: state.viewportTop,
			dirtyIndices: state.dirtyIndices ? new Set(state.dirtyIndices) : undefined,
			projection: new ViewportProjection(rows, new Set(state.hiddenRows), new Set(state.answerMarkers)),
		};
		const start = performance.now();
		target.renderer.paintGrid(rows, state.metrics, options);
		results.push({ session: event.session, at: event.at, paint_ms: performance.now() - start, rows: rows.size });
	}
	return {
		source: recording.source,
		dropped: recording.dropped,
		frames: results,
		claim: "grid paint timing only; not the real-stall heartbeat RED",
	};
}
