import { createEffect, createMemo, on, untrack } from "solid-js";
import { githubStore } from "../stores/github";
import type { GitHubStatus } from "../types";

/**
 * GitHub status hook — reactive wrapper around the centralized githubStore.
 *
 * Reads remote tracking data (ahead/behind) from the store's unified polling
 * instead of maintaining its own independent timer.
 */
export function useGitHub(getRepoPath: () => string | undefined) {
	const status = createMemo<GitHubStatus | null>(() => {
		const path = getRepoPath();
		if (!path) return null;
		return githubStore.getRemoteStatus(path);
	});

	// Repo roots are filled by the Rust poller; a worktree checkout is not, so fetch it once
	// when it is first asked for (later refreshes ride the poller's update events).
	createEffect(
		on(getRepoPath, (path) => {
			if (path && !untrack(() => githubStore.getRemoteStatus(path))) githubStore.pollRemoteStatus(path);
		}),
	);

	const loading = () => false;
	const error = () => null;

	function refresh(): void {
		const path = getRepoPath();
		if (path) githubStore.pollRepo(path);
	}

	return {
		status,
		loading,
		error,
		refresh,
		startPolling: () => {},
		stopPolling: () => {},
	};
}
