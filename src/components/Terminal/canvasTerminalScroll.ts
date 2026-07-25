import type { DecodedRow } from "./canvasTerminalUtils";

export interface CanvasScrollController {
	readonly rowCache: Map<number, DecodedRow>;
	readonly requestedChunks: Set<number>;
	position: number | null;
	pendingOffset: number | null;
	inFlight: boolean;
	scrolling: boolean;
	settleTarget: number | null;
	gestureDistancePx: number;
	clearCache: () => void;
	applyDelta: (deltaLines: number, currentOffset: number, historySize: number) => number;
	snap: () => number | null;
	acceptSettledFrame: (displayOffset: number) => boolean;
	cancel: () => void;
}

export function createCanvasScrollController(): CanvasScrollController {
	const rowCache = new Map<number, DecodedRow>();
	const requestedChunks = new Set<number>();
	let position: number | null = null;
	let pendingOffset: number | null = null;
	let inFlight = false;
	let scrolling = false;
	let settleTarget: number | null = null;
	let gestureDistancePx = 0;

	return {
		rowCache,
		requestedChunks,
		get position() {
			return position;
		},
		set position(value) {
			position = value;
		},
		get pendingOffset() {
			return pendingOffset;
		},
		set pendingOffset(value) {
			pendingOffset = value;
		},
		get inFlight() {
			return inFlight;
		},
		set inFlight(value) {
			inFlight = value;
		},
		get scrolling() {
			return scrolling;
		},
		set scrolling(value) {
			scrolling = value;
		},
		get settleTarget() {
			return settleTarget;
		},
		set settleTarget(value) {
			settleTarget = value;
		},
		get gestureDistancePx() {
			return gestureDistancePx;
		},
		set gestureDistancePx(value) {
			gestureDistancePx = value;
		},
		clearCache() {
			rowCache.clear();
			requestedChunks.clear();
		},
		applyDelta(deltaLines, currentOffset, historySize) {
			scrolling = true;
			const base = position ?? currentOffset;
			position = Math.max(0, Math.min(historySize, base - deltaLines));
			pendingOffset = Math.floor(position);
			return position;
		},
		snap() {
			scrolling = false;
			gestureDistancePx = 0;
			if (position === null) return null;
			const target = Math.round(position);
			position = target;
			pendingOffset = target;
			settleTarget = target;
			return target;
		},
		acceptSettledFrame(displayOffset) {
			if (settleTarget === null || displayOffset !== settleTarget) return false;
			settleTarget = null;
			position = null;
			return true;
		},
		cancel() {
			position = null;
			pendingOffset = null;
			scrolling = false;
			settleTarget = null;
			gestureDistancePx = 0;
		},
	};
}
