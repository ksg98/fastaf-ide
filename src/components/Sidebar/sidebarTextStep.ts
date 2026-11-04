/** Sidebar widths (px) at which its text grows by one more pixel, widest first. */
const TEXT_STEP_THRESHOLDS = [450, 400, 350] as const;

/** Pixels added to the sidebar font tokens at this sidebar width: 0 below 350, then +1 per 50px. */
export function sidebarTextStep(sidebarWidth: number): number {
	const crossed = TEXT_STEP_THRESHOLDS.findIndex((min) => sidebarWidth >= min);
	return crossed === -1 ? 0 : TEXT_STEP_THRESHOLDS.length - crossed;
}
