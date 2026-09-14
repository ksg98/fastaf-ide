// Per-frame revision-bump coalescer for the repo-changed cascade.
//
// `repo-changed` events can arrive in same-frame bursts (a real change touching
// both .git/index and refs/**, or several repos at once). Bumping the repo
// revision synchronously on each one fires the full ~20-effect SolidJS flush per
// event. This collapses a burst into AT MOST ONE bump per repo per animation
// frame — without ever LOSING a bump (each distinct repo is flushed on the next
// frame), so panels still re-fetch fresh data exactly once.

export interface RevisionCoalescer {
	/**
	 * Queue a revision bump for `repoPath`, delivered once on the next frame.
	 * `isGitState` merges upward across a burst: one git-state event in the
	 * frame makes the whole collapsed bump git-state, because that kind is a
	 * superset of what a working-tree one signals.
	 */
	bump(repoPath: string, isGitState: boolean): void;
	/** Cancel any pending flush (teardown). */
	dispose(): void;
}

/** Schedule a callback to run on the next animation frame. */
export type FrameScheduler = (cb: () => void) => number;
/** Cancel a previously scheduled frame callback. */
export type FrameCanceller = (handle: number) => void;

const defaultSchedule: FrameScheduler = (cb) => requestAnimationFrame(cb);
const defaultCancel: FrameCanceller = (handle) => cancelAnimationFrame(handle);

/**
 * Create a coalescer that delivers at most one `bump(repoPath)` per repo per
 * scheduled frame. `schedule`/`cancel` are injectable for deterministic tests.
 */
export function createRevisionCoalescer(
	bump: (repoPath: string, isGitState: boolean) => void,
	schedule: FrameScheduler = defaultSchedule,
	cancel: FrameCanceller = defaultCancel,
): RevisionCoalescer {
	const pending = new Map<string, boolean>();
	let handle: number | null = null;

	const flush = () => {
		handle = null;
		// Snapshot before delivering: a bump fired during flush re-arms a new frame
		// rather than mutating the map we're iterating.
		const batch = [...pending];
		pending.clear();
		for (const [path, isGitState] of batch) bump(path, isGitState);
	};

	return {
		bump(repoPath: string, isGitState: boolean): void {
			pending.set(repoPath, (pending.get(repoPath) ?? false) || isGitState);
			if (handle === null) handle = schedule(flush);
		},
		dispose(): void {
			if (handle !== null) {
				cancel(handle);
				handle = null;
			}
			pending.clear();
		},
	};
}
