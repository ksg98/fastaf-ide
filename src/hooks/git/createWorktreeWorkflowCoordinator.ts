import type { Accessor, Setter } from "solid-js";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { autofixBranchName } from "../../stores/autofix";
import { githubStore } from "../../stores/github";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { effectiveMergeMethod, isMergeMethodNotAllowed } from "../../utils/prMerge";
import { type AgentSeed, buildAgentSeed } from "./agentSeed";
import type { PendingCreation } from "./createRepositoryRefreshCoordinator";

interface WorktreeWorkflowCoordinatorDeps {
	repo: {
		listBaseRefOptions: (repoPath: string) => Promise<Array<{ name: string; is_default?: boolean }>>;
		createWorktree: (
			baseRepo: string,
			branchName: string,
			createBranch?: boolean,
			baseRef?: string,
		) => Promise<PendingCreation["result"] & { status: "ok" | "pending" }>;
		mergePrViaGithub: (repoPath: string, prNumber: number, mergeMethod: string) => Promise<string>;
		mergeAndArchiveWorktree: (
			repoPath: string,
			branchName: string,
			targetBranch: string,
			afterMerge: string,
			force?: boolean,
		) => Promise<{
			merged: boolean;
			action: string;
			archive_path: string | null;
			commits_ahead?: number;
			worktree_dirty?: boolean;
		}>;
		finalizeMergedWorktree: (
			repoPath: string,
			branchName: string,
			action: "archive" | "delete",
			force?: boolean,
		) => Promise<{ merged: boolean; action: string; archive_path: string | null }>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	setStatusInfo: (message: string) => void;
	/** Ask the user to confirm a cleanup that would destroy the worktree's
	 *  uncommitted work. Resolves false to abort. */
	confirmDirtyWorktreeCleanup: (branchName: string, action: string, commitsAhead: number) => Promise<boolean>;
	creatingWorktreeRepos: Accessor<Set<string>>;
	setCreatingWorktreeRepos: Setter<Set<string>>;
	setMergePendingCtx: Setter<{
		repoPath: string;
		branchName: string;
		baseBranch: string;
		hasDirtyFiles: boolean;
		worktreeDirty: boolean;
	} | null>;
	pendingCreations: Map<string, PendingCreation>;
	pendingKey: (repoPath: string, branchName: string) => string;
	markRecentlyCreated: (repoPath: string, branchName: string) => void;
	setupNewWorktree: (
		repoPath: string,
		result: PendingCreation["result"],
		displayName: string,
		agentSeed?: AgentSeed,
	) => Promise<void>;
	refreshAllBranchStats: () => Promise<void>;
}

/** Owns auto-fix, conflict assist, merge, and post-merge cleanup workflows. */
export function createWorktreeWorkflowCoordinator(deps: WorktreeWorkflowCoordinatorDeps) {
	const {
		creatingWorktreeRepos,
		setCreatingWorktreeRepos,
		setMergePendingCtx,
		pendingCreations,
		pendingKey,
		markRecentlyCreated,
		setupNewWorktree,
		refreshAllBranchStats,
	} = deps;

	/** Auto-fix an issue: create a fresh `autofix/issue-<n>` worktree off the
	 *  default branch and launch the default agent in it seeded with `prompt`.
	 *  Mirrors confirmCreateWorktree's create + pending/error handling; the agent
	 *  seed is threaded into setupNewWorktree so the terminal's agentType +
	 *  pendingInitCommand are set in the same window the runScript path uses. */
	const handleAutofixIssue = async (repoPath: string, issueNumber: number, prompt: string) => {
		if (creatingWorktreeRepos().has(repoPath)) return;
		setCreatingWorktreeRepos((prev) => new Set([...prev, repoPath]));

		const branch = autofixBranchName(issueNumber);
		const agentSeed = buildAgentSeed(prompt);

		let pendingHandoff = false;
		try {
			// Fork the auto-fix branch off the repo's default branch (main/master).
			const baseRefs = await deps.repo.listBaseRefOptions(repoPath);
			const base = baseRefs.find((r) => r.is_default)?.name ?? baseRefs[0]?.name ?? "main";

			deps.setStatusInfo(`Creating auto-fix worktree ${branch}...`);
			const result = await deps.repo.createWorktree(repoPath, branch, true, base);

			if (result.status === "pending") {
				// Stale directory being cleaned in background — show placeholder and
				// defer setupNewWorktree (with the seed) until the recreate completes.
				markRecentlyCreated(repoPath, result.branch);
				repositoriesStore.setBranch(repoPath, result.branch, {
					worktreePath: result.path,
					isPreparing: true,
				});
				repositoriesStore.setActiveBranch(repoPath, result.branch);
				deps.setStatusInfo(`Preparing auto-fix worktree ${branch}...`);
				pendingCreations.set(pendingKey(repoPath, result.branch), {
					repoPath,
					displayName: branch,
					result,
					agentSeed,
				});
				pendingHandoff = true;
			} else {
				await setupNewWorktree(repoPath, result, branch, agentSeed);
			}
		} catch (err) {
			appLogger.error("git", "Failed to create auto-fix worktree", err);
			deps.setStatusInfo(`Failed to create auto-fix worktree: ${err}`);
		} finally {
			if (!pendingHandoff) {
				setCreatingWorktreeRepos((prev) => {
					const next = new Set(prev);
					next.delete(repoPath);
					return next;
				});
			}
		}
	};

	/** Resolve a PR's merge conflicts: the backend has already created a worktree
	 *  on the PR head branch and rebased it onto `base`. On a clean rebase we just
	 *  report success; on conflicts we register the existing worktree and open the
	 *  default agent in it, seeded with the backend's ready-to-inject resolution
	 *  prompt. The worktree already exists, so we call setupNewWorktree directly
	 *  (it registers, adds a terminal, and applies the seed — it does NOT create). */
	const handleConflictAssist = async (repoPath: string, prNumber: number) => {
		if (creatingWorktreeRepos().has(repoPath)) return;
		setCreatingWorktreeRepos((prev) => new Set([...prev, repoPath]));

		try {
			const result = await invoke<{
				status: "clean" | "clean_unverified" | "conflicts";
				worktree_path: string;
				branch: string;
				base: string;
				base_source: "fetched_remote" | "existing_tracking" | "local_fallback";
				base_warning: string | null;
				conflicted_files: string[];
				prompt: string;
			}>("start_conflict_assist", { repoPath, prNumber });

			if (result.status === "clean" || result.status === "clean_unverified") {
				deps.setStatusInfo(
					result.base_warning
						? `PR #${prNumber} rebased without conflicts onto ${result.base}. ${result.base_warning}`
						: `PR #${prNumber} rebased cleanly onto ${result.base}`,
				);
				return;
			}

			await setupNewWorktree(
				repoPath,
				{ name: result.branch, path: result.worktree_path, branch: result.branch, base_repo: repoPath },
				result.branch,
				buildAgentSeed(result.prompt),
			);
		} catch (err) {
			appLogger.error("git", `Failed to start conflict assist for PR #${prNumber}`, err);
			deps.setStatusInfo(`Failed to resolve conflicts for PR #${prNumber}: ${err}`);
		} finally {
			setCreatingWorktreeRepos((prev) => {
				const next = new Set(prev);
				next.delete(repoPath);
				return next;
			});
		}
	};

	/** Merge a worktree branch into target, then archive/delete based on setting.
	 *  When the branch has an open PR, uses GitHub API with the configured merge strategy.
	 *  Falls back to local git merge if no PR is found or GitHub API fails. */
	/** Close all terminals whose cwd is inside a worktree path. */
	const closeTerminalsInWorktree = async (wtPath: string) => {
		for (const termId of terminalsStore.getIds()) {
			const terminal = terminalsStore.get(termId);
			if (terminal?.cwd && (terminal.cwd === wtPath || terminal.cwd.startsWith(wtPath + "/"))) {
				await deps.closeTerminal(termId, true);
			}
		}
	};

	/** Close all terminals belonging to a branch. */
	const closeTerminalsForBranch = async (repoPath: string, branchName: string) => {
		const repoState = repositoriesStore.get(repoPath);
		const branch = repoState?.branches[branchName];
		if (branch) {
			for (const termId of branch.terminals) {
				await deps.closeTerminal(termId, true);
			}
		}
	};

	const handleMergeAndArchive = async (
		repoPath: string,
		branchName: string,
		targetBranch: string,
		afterMerge: string,
	) => {
		try {
			deps.setStatusInfo(`Merging ${branchName} into ${targetBranch}...`);

			// Use GitHub API when a PR exists for this branch
			const pr = githubStore.getPrStatus(repoPath, branchName);
			if (pr && pr.state === "OPEN") {
				const preferred = repoSettingsStore.getEffective(repoPath)?.prMergeStrategy ?? "merge";
				const method = effectiveMergeMethod(pr, preferred);
				try {
					await deps.repo.mergePrViaGithub(repoPath, pr.number, method);
				} catch (githubErr) {
					if (isMergeMethodNotAllowed(githubErr)) {
						// Surface 405 to the caller — branch protection rules disallow this merge method
						throw githubErr;
					}
					// Other GitHub API failures — fall back to local git merge
					appLogger.warn("git", `GitHub API merge failed, falling back to local git merge: ${githubErr}`);
					await mergeLocalAndFinalize(repoPath, branchName, targetBranch, afterMerge);
					return;
				}
				// GitHub merge succeeded — close terminals and finalize the worktree locally
				await closeTerminalsForBranch(repoPath, branchName);
				if (afterMerge === "ask") {
					deps.setStatusInfo(`Merged ${branchName} via GitHub — choose what to do with the worktree`);
					await openCleanupDialog(repoPath, branchName, targetBranch);
					return;
				}
				const action = afterMerge as "archive" | "delete";
				if (!(await finalizeWithConfirmation(repoPath, branchName, action))) {
					deps.setStatusInfo(`Merged ${branchName} via GitHub — worktree kept`);
					await refreshAllBranchStats();
					return;
				}
				deps.setStatusInfo(`Merged ${branchName} via GitHub (${action === "archive" ? "archived" : "deleted"})`);
				repositoriesStore.removeBranch(repoPath, branchName);
				await refreshAllBranchStats();
				return;
			}

			// No open PR — local git merge
			await mergeLocalAndFinalize(repoPath, branchName, targetBranch, afterMerge);
		} catch (err) {
			if (isMergeMethodNotAllowed(err)) {
				throw err;
			}
			appLogger.error("git", "Failed to merge and archive worktree", err);
			deps.setStatusInfo(`Failed to merge: ${err}`);
		}
	};

	/** Collect everything the post-merge cleanup dialog needs to warn honestly.
	 *
	 *  Two different directories, two different warnings:
	 *  - `hasDirtyFiles` is the BASE repo — the "Switch to <base>" step stashes it.
	 *  - `worktreeDirty` is the BRANCH's worktree — the "Archive/Delete worktree"
	 *    step ends in `git worktree remove --force` and would take it for good.
	 *  Either check failing is reported as dirty: an unanswered question must not
	 *  read as "nothing to lose" when it gates a destructive step. */
	const openCleanupDialog = async (repoPath: string, branchName: string, baseBranch: string) => {
		let hasDirtyFiles = false;
		try {
			const status = await invoke<{ stdout: string }>("run_git_command", {
				path: repoPath,
				args: ["status", "--porcelain"],
			});
			hasDirtyFiles = status.stdout.trim().length > 0;
		} catch (err) {
			appLogger.warn("git", `Could not check dirty status for ${repoPath}, assuming dirty`, err);
			hasDirtyFiles = true;
		}

		let worktreeDirty = false;
		try {
			worktreeDirty = await invoke<boolean>("check_worktree_dirty", { repoPath, branchName });
		} catch (err) {
			appLogger.warn("git", `Could not check the ${branchName} worktree, assuming dirty`, err);
			worktreeDirty = true;
		}

		setMergePendingCtx({ repoPath, branchName, baseBranch, hasDirtyFiles, worktreeDirty });
	};

	/** Archive/delete a merged worktree, asking first when the backend refuses.
	 *  Returns false when the user declined and the worktree is still on disk. */
	const finalizeWithConfirmation = async (repoPath: string, branchName: string, action: "archive" | "delete") => {
		const result = await deps.repo.finalizeMergedWorktree(repoPath, branchName, action);
		if (result.action !== "needs_confirmation") return true;

		// The merge already landed; only the cleanup stopped. Nothing is lost yet.
		if (!(await deps.confirmDirtyWorktreeCleanup(branchName, action, 0))) return false;
		await deps.repo.finalizeMergedWorktree(repoPath, branchName, action, true);
		return true;
	};

	/** Local git merge path: checkout target, merge, then archive/delete/ask. */
	const mergeLocalAndFinalize = async (
		repoPath: string,
		branchName: string,
		targetBranch: string,
		afterMerge: string,
	) => {
		let result = await deps.repo.mergeAndArchiveWorktree(repoPath, branchName, targetBranch, afterMerge);

		// The backend refused: the worktree is not known to be clean, so archiving or
		// deleting it would make the row vanish and take that uncommitted work with
		// it. Neither the merge nor the cleanup has run — ask, then retry with force.
		if (result.action === "needs_confirmation") {
			const proceed = await deps.confirmDirtyWorktreeCleanup(branchName, afterMerge, result.commits_ahead ?? 0);
			if (!proceed) {
				deps.setStatusInfo(`Left ${branchName} alone — its worktree still has uncommitted work`);
				return;
			}
			result = await deps.repo.mergeAndArchiveWorktree(repoPath, branchName, targetBranch, afterMerge, true);
		}

		// Merge succeeded — close terminals now (not before, to avoid orphaning the branch on failure)
		await closeTerminalsForBranch(repoPath, branchName);

		if (result.action === "pending") {
			// "ask" mode — merge succeeded, user must choose what to do with the worktree
			deps.setStatusInfo(`Merged ${branchName} into ${targetBranch} — choose what to do with the worktree`);
			await openCleanupDialog(repoPath, branchName, targetBranch);
			// Branch stays in sidebar until the user decides via cleanup dialog
			return;
		}

		// Say what the merge actually did. "Already up to date" and "brought 7 commits
		// across" both end here with action=archived, and the row disappears either
		// way — without the count the user cannot tell an empty branch from a real one.
		const ahead = result.commits_ahead ?? 0;
		const carried = ahead === 0 ? "nothing to merge" : `${ahead} commit${ahead === 1 ? "" : "s"}`;
		deps.setStatusInfo(`${branchName} → ${targetBranch}: ${carried} (${result.action})`);

		// Remove branch from sidebar
		repositoriesStore.removeBranch(repoPath, branchName);

		// Refresh to pick up updated branch stats
		await refreshAllBranchStats();
	};

	/** Dismiss the post-merge cleanup dialog. */
	const dismissMergePending = () => {
		setMergePendingCtx(null);
	};

	return {
		closeTerminalsForBranch,
		closeTerminalsInWorktree,
		dismissMergePending,
		handleAutofixIssue,
		handleConflictAssist,
		handleMergeAndArchive,
	};
}
