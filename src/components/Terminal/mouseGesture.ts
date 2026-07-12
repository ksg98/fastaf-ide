/**
 * Click-vs-drag arbiter for terminals with mouse reporting enabled.
 *
 * When a TUI app has mouse mode on, a left mousedown could be either a click
 * the app should see, or the start of a text-selection drag it should not.
 * The arbiter withholds judgment at mousedown: movement past the threshold
 * commits the gesture to selection; release without movement resolves it as
 * a click the caller replays to the PTY as a press+release pair.
 */

/** Minimum pointer travel (px, euclidean) before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 5;

/**
 * Outcome of a pointer move:
 * - "idle": no press is being tracked — caller forwards motion as usual
 * - "pending": press held but under the threshold — forward nothing yet
 * - "selecting": drag already committed — keep extending the selection
 * - { kind: "start" }: this move crossed the threshold; begin a selection
 *   anchored at the stored mousedown payload
 */
export type MoveResult<T> = "idle" | "pending" | "selecting" | { kind: "start"; down: T };

/**
 * Outcome of a pointer release:
 * - { kind: "idle" }: nothing tracked — caller forwards the release as usual
 * - { kind: "click" }: press never moved past the threshold — replay it to
 *   the PTY as a click at the stored mousedown payload
 * - { kind: "endSelection" }: a drag-selection just finished — finalize it
 */
export type UpResult<T> = { kind: "idle" } | { kind: "click"; down: T } | { kind: "endSelection" };

/**
 * Create a stateful arbiter. `T` is an opaque payload captured at mousedown
 * (grid position, original event, …) and handed back when the gesture
 * resolves as a click or a selection start.
 */
export function createClickDragArbiter<T>(threshold = DRAG_THRESHOLD_PX) {
	let down: { x: number; y: number; payload: T } | null = null;
	let inSelection = false;

	return {
		/** Track a left mousedown; the payload is returned on click/drag-start. */
		onDown(x: number, y: number, payload: T): void {
			down = { x, y, payload };
			inSelection = false;
		},

		/** Classify a pointer move. See {@link MoveResult}. */
		onMove(x: number, y: number): MoveResult<T> {
			if (inSelection) return "selecting";
			if (!down) return "idle";
			if (Math.hypot(x - down.x, y - down.y) >= threshold) {
				inSelection = true;
				return { kind: "start", down: down.payload };
			}
			return "pending";
		},

		/** Resolve the gesture on pointer release. See {@link UpResult}. */
		onUp(): UpResult<T> {
			if (inSelection) {
				down = null;
				inSelection = false;
				return { kind: "endSelection" };
			}
			if (down) {
				const payload = down.payload;
				down = null;
				return { kind: "click", down: payload };
			}
			return { kind: "idle" };
		},

		/** Drop any tracked gesture (e.g. on focus loss). */
		reset(): void {
			down = null;
			inSelection = false;
		},
	};
}
