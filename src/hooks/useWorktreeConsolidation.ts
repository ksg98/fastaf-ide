import { createEffect } from "solid-js";
import { globalWorkspaceStore, MANUAL_SCOPE } from "../stores/globalWorkspace";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";

/**
 * Terminal ids of every worktree of `repoPath`, in branch order.
 *
 * The main branch is excluded: it has no worktree directory (`worktreePath` is
 * null), so consolidating it would drop the repo's ordinary terminals into the
 * worktree view.
 */
export function worktreeTerminalsOf(repoPath: string): string[] {
	const repo = repositoriesStore.state.repositories[repoPath];
	if (!repo) return [];
	return Object.values(repo.branches)
		.filter((branch) => branch.worktreePath !== null)
		.flatMap((branch) => branch.terminals);
}

/** Repos whose per-repo consolidation toggle is on. */
export function consolidatedRepos(): string[] {
	return Object.values(repoSettingsStore.state.settings)
		.filter((settings) => settings.autoConsolidateWorktrees)
		.map((settings) => settings.path);
}

/**
 * Keep each consolidated repo's workspace in sync with its worktrees (#e767).
 *
 * Declarative rather than event-driven: the effect recomputes the full member
 * list from the repositories store, so a worktree created, removed or archived
 * needs no dedicated hook — the store write that adds or drops its terminals is
 * the trigger, and `syncScopeMembers` is idempotent.
 *
 * Every enabled repo is synced, not just the active one, so switching to a
 * consolidated repo shows a view that is already correct instead of one that
 * assembles itself after the fact.
 */
export function useWorktreeConsolidation(): void {
	createEffect(() => {
		for (const repoPath of consolidatedRepos()) {
			globalWorkspaceStore.syncScopeMembers(repoPath, worktreeTerminalsOf(repoPath));
		}
	});

	// Show the consolidated view when the active repo has it on, and get out of
	// the way when it does not. The MANUAL_SCOPE guard is what keeps this from
	// closing a workspace the user promoted by hand.
	createEffect(() => {
		const repoPath = repositoriesStore.state.activeRepoPath;
		const enabled = repoPath ? (repoSettingsStore.state.settings[repoPath]?.autoConsolidateWorktrees ?? false) : false;

		if (enabled && repoPath) {
			globalWorkspaceStore.setScope(repoPath);
			if (!globalWorkspaceStore.isActive() && globalWorkspaceStore.hasPromoted()) {
				globalWorkspaceStore.activate();
			}
			return;
		}
		if (globalWorkspaceStore.getScope() !== MANUAL_SCOPE) {
			globalWorkspaceStore.deactivate();
			globalWorkspaceStore.setScope(MANUAL_SCOPE);
		}
	});
}
