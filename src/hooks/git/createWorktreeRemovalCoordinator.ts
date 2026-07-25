import type { Accessor, Setter } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import type { RemoveWorktreeResult } from "../useRepository";

interface WorktreeRemovalCoordinatorDeps {
	repo: {
		removeWorktree: (
			repoPath: string,
			branchName: string,
			deleteBranch: boolean,
			force?: boolean,
		) => Promise<RemoveWorktreeResult | undefined>;
	};
	dialogs: {
		confirmRemoveWorktree: (branchName: string) => Promise<boolean>;
		confirmRemoveLockedWorktree?: (branchName: string, deleteBranch?: boolean) => Promise<boolean>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	setStatusInfo: (message: string) => void;
	removingBranches: Accessor<Set<string>>;
	setRemovingBranches: Setter<Set<string>>;
}

function describeRemoveWorktreeSuccess(branchName: string, outcome: RemoveWorktreeResult | undefined): string {
	if (outcome?.branch_delete_warning) {
		return `Removed ${branchName} worktree; branch was kept: ${outcome.branch_delete_warning}`;
	}
	return `Removed ${branchName}`;
}

/** Owns worktree removal locking, force recovery, and store cleanup. */
export function createWorktreeRemovalCoordinator(deps: WorktreeRemovalCoordinatorDeps) {
	const { removingBranches, setRemovingBranches } = deps;

	const handleRemoveBranch = async (repoPath: string, branchName: string) => {
		const removeKey = `${repoPath}::${branchName}`;
		// Lock IMMEDIATELY (synchronously) to prevent concurrent invocations that race the awaits below
		if (removingBranches().has(removeKey)) return;
		setRemovingBranches((prev) => new Set([...prev, removeKey]));

		const clearLock = () => {
			setRemovingBranches((prev) => {
				const next = new Set(prev);
				next.delete(removeKey);
				return next;
			});
		};

		const repoState = repositoriesStore.get(repoPath);
		const branch = repoState?.branches[branchName];
		if (!branch?.worktreePath) {
			deps.setStatusInfo(`Cannot remove ${branchName}: not a worktree`);
			clearLock();
			return;
		}

		const confirmed = await deps.dialogs.confirmRemoveWorktree(branchName);
		if (!confirmed) {
			clearLock();
			return;
		}

		// Show "Removing…" in sidebar as soon as the user confirms — before
		// the terminal-close loop, which can take noticeable time. Otherwise
		// the lock is held while the UI still appears clickable.
		repositoriesStore.setBranch(repoPath, branchName, { isRemoving: true });

		// Close terminals defensively: a thrown error here used to leak the
		// removingBranches lock (clearLock was unreachable) and left isRemoving
		// stuck. Catch per-terminal so one bad PTY doesn't block cleanup.
		for (const termId of branch.terminals) {
			try {
				await deps.closeTerminal(termId, true);
			} catch (err) {
				appLogger.warn("git", `handleRemoveBranch: closeTerminal failed`, {
					termId,
					branchName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const effective = repoSettingsStore.getEffective(repoPath);
		const deleteBranch = effective?.deleteBranchOnRemove ?? true;
		appLogger.info("git", `handleRemoveBranch: invoking remove_worktree`, {
			repoPath,
			branchName,
			worktreePath: branch.worktreePath,
			deleteBranch,
		});

		// Tracks whether to remove the branch from the store at the end.
		// Set to true on success or non-fatal non-lock errors (old "remove from UI" behavior).
		// Stays false when: locked+cancelled, or force-remove failed (worktree still in git).
		let shouldRemoveFromStore = false;
		let shouldClearBranchLabel = true;
		try {
			const outcome = await deps.repo.removeWorktree(repoPath, branchName, deleteBranch);
			appLogger.info("git", `handleRemoveBranch: remove_worktree SUCCESS`, { branchName });
			shouldRemoveFromStore = true;
			shouldClearBranchLabel = !outcome?.branch_delete_warning;
			deps.setStatusInfo(describeRemoveWorktreeSuccess(branchName, outcome));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (reason.startsWith("worktree_locked:")) {
				// Worktree is locked by a Claude agent — ask user to confirm force removal
				repositoriesStore.setBranch(repoPath, branchName, { isRemoving: false });
				appLogger.warn("git", `handleRemoveBranch: worktree locked — showing confirmation dialog`, {
					branchName,
					reason,
				});
				// Pass deleteBranch so the dialog can warn about unmerged-commit loss
				// when force=true causes `git branch -D` to run on a branch with
				// unpushed work. Catch dialog rejection so the removingBranches
				// lock is released even when the modal subsystem errors out.
				let forceConfirmed = false;
				try {
					forceConfirmed = await (deps.dialogs.confirmRemoveLockedWorktree?.(branchName, deleteBranch) ?? false);
				} catch (dialogErr) {
					appLogger.error("git", `handleRemoveBranch: confirmRemoveLockedWorktree threw`, {
						branchName,
						error: dialogErr instanceof Error ? dialogErr.message : String(dialogErr),
					});
					deps.setStatusInfo(`Failed to confirm force-remove for ${branchName}`);
					clearLock();
					return;
				}
				if (!forceConfirmed) {
					appLogger.info("git", `handleRemoveBranch: user cancelled force removal of locked worktree`, { branchName });
					clearLock();
					return;
				}
				repositoriesStore.setBranch(repoPath, branchName, { isRemoving: true });
				try {
					const outcome = await deps.repo.removeWorktree(repoPath, branchName, deleteBranch, true);
					appLogger.info("git", `handleRemoveBranch: force remove_worktree SUCCESS`, { branchName });
					shouldRemoveFromStore = true;
					shouldClearBranchLabel = !outcome?.branch_delete_warning;
					deps.setStatusInfo(describeRemoveWorktreeSuccess(branchName, outcome));
				} catch (forceErr) {
					const forceReason = forceErr instanceof Error ? forceErr.message : String(forceErr);
					appLogger.error("git", `handleRemoveBranch: force remove_worktree FAILED`, {
						branchName,
						reason: forceReason,
					});
					deps.setStatusInfo(`Failed to remove ${branchName}: ${forceReason}`);
					repositoriesStore.setBranch(repoPath, branchName, { isRemoving: false });
					clearLock();
					return;
				}
			} else if (reason.startsWith("worktree_is_main:")) {
				appLogger.warn("git", `handleRemoveBranch: branch is in main worktree — cannot remove as worktree`, {
					branchName,
				});
				deps.setStatusInfo(`Cannot remove ${branchName}: branch is in the main worktree, not a linked worktree`);
				repositoriesStore.setBranch(repoPath, branchName, { isRemoving: false });
				clearLock();
				return;
			} else {
				appLogger.error("git", `handleRemoveBranch: remove_worktree FAILED — branch will be removed from UI only`, {
					branchName,
					reason,
				});
				shouldRemoveFromStore = true;
				deps.setStatusInfo(`Removed ${branchName} from UI (worktree removal failed)`);
			}
		}

		if (!shouldRemoveFromStore) {
			repositoriesStore.setBranch(repoPath, branchName, { isRemoving: false });
			clearLock();
			return;
		}
		appLogger.info("git", `handleRemoveBranch: calling removeBranch on store`, { branchName });
		clearLock();
		repositoriesStore.removeBranch(repoPath, branchName);
		if (shouldClearBranchLabel) {
			repoSettingsStore.setLabel(repoPath, branchName, null);
		}
	};

	return { handleRemoveBranch };
}
