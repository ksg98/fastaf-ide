import { onCleanup } from "solid-js";
import { createVisibilityGate } from "./pageVisibility";

/**
 * `setInterval` that only ticks while the page is visible.
 *
 * A backgrounded PWA has nothing to render, so every tick is pure battery and
 * radio cost. When the page becomes visible again the callback fires at once,
 * so the UI is never stale by up to a full interval.
 *
 * Must be called inside a reactive root — the timer and the listener are
 * released via `onCleanup`.
 */
export function createVisibilityInterval(tick: () => void, intervalMs: number): void {
	let timer: ReturnType<typeof setInterval> | null = null;

	const start = () => {
		if (timer === null) timer = setInterval(tick, intervalMs);
	};
	const stop = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	if (document.visibilityState !== "hidden") start();
	createVisibilityGate(stop, () => {
		// Catch up on whatever happened while hidden, then resume ticking.
		tick();
		start();
	});

	onCleanup(stop);
}
