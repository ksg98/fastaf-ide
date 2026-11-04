/** Opt-in evidence, not a stall detector or a lossless stream. No encoding/I/O in paint. */
import { isPerfDebug } from "../../utils/perfDebug";
import type { CellMetrics, DecodedRow } from "./canvasTerminalUtils";

export const WORKLOAD_BYTES = 4 * 1024 * 1024;
export const WORKLOAD_EVENTS = 256;
export const WORKLOAD_WINDOW_MS = 10_000;
export const WORKLOAD_FILE_BYTES = 6 * 1024 * 1024;

export interface PaintState {
	metrics: CellMetrics;
	fontFamily: string;
	fontWeight: string | number;
	width: number;
	height: number;
	background: string;
	foreground: string;
	neutral: string;
	hidden: boolean;
	fullRepaint: boolean;
	viewportTop?: number;
	projectionChanged: boolean;
	dirtyIndices?: number[];
	hiddenRows: number[];
	answerMarkers: number[];
}
type Event = { at: number; session: string; bytes: number } & (
	| { kind: "visibility"; hidden: boolean }
	| { kind: "arrival"; buffer: ArrayBuffer; hidden: boolean }
	| { kind: "paint"; rows: Map<number, DecodedRow>; state: PaintState }
);
export interface WorkloadRecording {
	schema_version: 1;
	source: "live" | "synthetic-smoke-not-stall-red";
	wall_time_origin_ms: number;
	reason: string;
	dropped: number;
	events: unknown[];
}

export class FrameWorkloadRecorder {
	private events: Event[] = [];
	private bytes = 0;
	private dropped = 0;
	private readonly rowCosts = new WeakMap<DecodedRow, number>();
	constructor(
		private readonly limit = WORKLOAD_BYTES,
		private readonly count = WORKLOAD_EVENTS,
	) {}
	private evict(now: number, incoming = 0) {
		while (
			this.events.length &&
			(this.bytes + incoming > this.limit ||
				(incoming > 0 && this.events.length >= this.count) ||
				now - this.events[0].at > WORKLOAD_WINDOW_MS)
		) {
			this.bytes -= this.events.shift()!.bytes;
			this.dropped++;
		}
	}
	arrival(session: string, buffer: ArrayBuffer, hidden: boolean, at: number) {
		const bytes = buffer.byteLength + session.length * 2 + 128;
		if (bytes > this.limit) {
			this.dropped++;
			return;
		}
		this.evict(at, bytes);
		this.events.push({ kind: "arrival", at, session, bytes, hidden, buffer: buffer.slice(0) });
		this.bytes += bytes;
	}
	paint(session: string, rows: ReadonlyMap<number, DecodedRow>, state: PaintState, at: number) {
		let bytes =
			1024 +
			session.length * 2 +
			state.fontFamily.length * 2 +
			((state.dirtyIndices?.length ?? 0) + state.hiddenRows.length + state.answerMarkers.length) * 8;
		for (const row of rows.values()) {
			let cost = this.rowCosts.get(row);
			if (cost === undefined) {
				cost = 256 + row.codepoints.byteLength + row.fg.byteLength + row.bg.byteLength + row.attrs.byteLength;
				for (const text of row.cellExtras?.values() ?? []) cost += 64 + text.length * 2;
				this.rowCosts.set(row, cost);
			}
			bytes += cost;
		}
		if (bytes > this.limit) {
			this.dropped++;
			return;
		}
		this.evict(at, bytes);
		// Decoder rows are immutable. A map snapshot retains cells without copying/encoding them.
		this.events.push({ kind: "paint", at, session, bytes, rows: new Map(rows), state });
		this.bytes += bytes;
	}
	visibility(session: string, hidden: boolean, at: number) {
		const bytes = session.length * 2 + 128;
		if (bytes > this.limit) {
			this.dropped++;
			return;
		}
		this.evict(at, bytes);
		this.events.push({ kind: "visibility", at, session, hidden, bytes });
		this.bytes += bytes;
	}
	status() {
		return { events: this.events.length, bytes: this.bytes, dropped: this.dropped };
	}
	clear() {
		this.events = [];
		this.bytes = 0;
		this.dropped = 0;
	}
	snapshot(reason: string, _now: number): WorkloadRecording {
		return this.freezeSnapshot(reason)();
	}
	freezeSnapshot(reason: string): () => WorkloadRecording {
		const retained = this.events.slice();
		const dropped = this.dropped;
		return () => {
			// A paint can block longer than the retention window. Do not age out the
			// very workload that just blocked us; age eviction runs on new arrivals.
			const events = retained.map((event) => {
				const { bytes: _bytes, ...common } = event;
				if (event.kind === "visibility") return common;
				if (event.kind === "arrival") {
					const { buffer: _buffer, ...rest } = common as Extract<Event, { kind: "arrival" }>;
					return { ...rest, binary: encodeBytes(new Uint8Array(event.buffer)) };
				}
				const { rows: _rows, ...rest } = common as Extract<Event, { kind: "paint" }>;
				return {
					...rest,
					rows: [...event.rows.values()].map((row) => ({
						index: row.index,
						count: row.count,
						wrapped: row.wrapped,
						codepoints: encodeU32(row.codepoints),
						fg: encodeU32(row.fg),
						bg: encodeU32(row.bg),
						attrs: encodeBytes(row.attrs),
						cellExtras: [...(row.cellExtras ?? [])],
					})),
				};
			});
			return {
				schema_version: 1,
				source: "live",
				wall_time_origin_ms: performance.timeOrigin,
				reason: reason.slice(0, 128),
				dropped,
				events,
			};
		};
	}
}
function encodeU32(values: Uint32Array): string {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	values.forEach((value, i) => view.setUint32(i * 4, value, true));
	return encodeBytes(bytes);
}
function encodeBytes(bytes: Uint8Array): string {
	let text = "";
	for (let start = 0; start < bytes.length; start += 8192)
		text += String.fromCharCode(...bytes.subarray(start, start + 8192));
	return btoa(text);
}
const recorder = new FrameWorkloadRecorder();
let enabled = false;
let saving: Promise<unknown> | undefined;
let lastAutomaticDump = -Infinity;
export function isFrameWorkloadEnabled() {
	return enabled && isPerfDebug();
}
export function setFrameWorkloadEnabled(on: boolean) {
	enabled = on;
	if (!on) recorder.clear();
	return frameWorkloadStatus();
}
export function frameWorkloadStatus() {
	return { enabled: isFrameWorkloadEnabled(), ...recorder.status() };
}
export function recordWorkloadVisibility(session: string, hidden: boolean) {
	if (isFrameWorkloadEnabled()) recorder.visibility(session, hidden, performance.now());
}
export function recordWorkloadArrival(session: string, buffer: ArrayBuffer, hidden: boolean) {
	if (isFrameWorkloadEnabled()) recorder.arrival(session, buffer, hidden, performance.now());
}
export function recordWorkloadPaint(session: string, rows: ReadonlyMap<number, DecodedRow>, state: PaintState) {
	if (isFrameWorkloadEnabled()) recorder.paint(session, rows, state, performance.now());
}
export function dumpFrameWorkload(reason = "manual", automatic = false): Promise<unknown> {
	if (!isFrameWorkloadEnabled()) return Promise.resolve({ skipped: "recorder disabled" });
	if (saving) return saving;
	const now = performance.now();
	if (automatic && now - lastAutomaticDump < 30_000) return Promise.resolve({ skipped: "cooldown" });
	if (automatic) lastAutomaticDump = now;
	// Freeze bounded references before yielding: later arrivals may evict the active window.
	const snapshot = recorder.freezeSnapshot(reason);
	// Yield past the paint callback. Encoding happens only at dump, never per frame.
	saving = new Promise((resolve) => setTimeout(resolve, 0))
		.then(async () => {
			if (!isFrameWorkloadEnabled()) return { skipped: "recorder disabled" };
			const recording = snapshot();
			let json = JSON.stringify(recording);
			while (new TextEncoder().encode(json).byteLength > WORKLOAD_FILE_BYTES && recording.events.length) {
				recording.events.shift();
				recording.dropped++;
				json = JSON.stringify(recording);
			}
			const { invoke } = await import("../../invoke");
			return invoke("save_frame_workload", { recording: json });
		})
		.finally(() => {
			saving = undefined;
		});
	return saving;
}
