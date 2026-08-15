/**
 * The app-zoom ladder. Kept dependency-free so both the settings store and the
 * zoom applier can import it without a cycle.
 *
 * Browser-style steps rather than a fixed multiplier — the increments stay
 * legible at both ends instead of crawling when small and jumping when large.
 */
export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5] as const;
export const ZOOM_DEFAULT = 1;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Nearest ladder step to an arbitrary stored value. */
function nearestIndex(level: number): number {
	let best = 0;
	for (let i = 1; i < ZOOM_STEPS.length; i++) {
		if (Math.abs(ZOOM_STEPS[i] - level) < Math.abs(ZOOM_STEPS[best] - level)) best = i;
	}
	return best;
}

/** The next step in `direction` from an arbitrary level. */
export function nextZoomStep(level: number, direction: 1 | -1): number {
	const i = nearestIndex(level);
	// Bias the starting index toward the direction of travel, so a level sitting
	// between two steps always moves instead of snapping back onto itself.
	const from = direction > 0 && ZOOM_STEPS[i] < level ? i + 1 : direction < 0 && ZOOM_STEPS[i] > level ? i - 1 : i;
	return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, from + direction))];
}
