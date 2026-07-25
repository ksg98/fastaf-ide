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
		) => Promise<{ merged: boolean; action: string; archive_path: string | null }>;
		finalizeMergedWorktree: (
			repoPath: string,
			branchName: string,
			action: "archive" | "delete",
		) => Promise<{ merged: boolean; action: string; archive_path: string | null }>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	setStatusInfo: (message: string) => void;
	creatingWorktreeRepos: Accessor<Set<string>>;
	setCreatingWorktreeRepos: Setter<Set<string>>;
	setMergePendingCtx: Setter<{
		repoPath: string;
		branchName: string;
		baseBranch: string;
		hasDirtyFiles: boolean;
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
				status: "clean" | "conflicts";
				worktree_path: string;
				branch: string;
				base: string;
				conflicted_files: string[];
				prompt: string;
			}>("start_conflict_assist", { repoPath, prNumber });

			if (result.status === "clean") {
				deps.setStatusInfo(`PR #${prNumber} rebased cleanly onto ${result.base}`);
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
					let hasDirtyFiles = false;
					try {
						const status = await invoke<{ stdout: string }>("run_git_command", {
							path: repoPath,
							args: ["status", "--porcelain"],
						});
						hasDirtyFiles = status.stdout.trim().length > 0;
					} catch (err) {
						appLogger.warn("git", `Could not check dirty status for ${repoPath}, assuming clean`, err);
					}
					setMergePendingCtx({ repoPath, branchName, baseBranch: targetBranch, hasDirtyFiles });
					return;
				}
				const action = afterMerge as "archive" | "delete";
				await deps.repo.finalizeMergedWorktree(repoPath, branchName, action);
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

	/** Local git merge path: checkout target, merge, then archive/delete/ask. */
	const mergeLocalAndFinalize = async (
		repoPath: string,
		branchName: string,
		targetBranch: string,
		afterMerge: string,
	) => {
		const result = await deps.repo.mergeAndArchiveWorktree(repoPath, branchName, targetBranch, afterMerge);

		// Merge succeeded — close terminals now (not before, to avoid orphaning the branch on failure)
		await closeTerminalsForBranch(repoPath, branchName);

		if (result.action === "pending") {
			// "ask" mode — merge succeeded, user must choose what to do with the worktree
			deps.setStatusInfo(`Merged ${branchName} into ${targetBranch} — choose what to do with the worktree`);
			let hasDirtyFiles = false;
			try {
				const status = await invoke<{ stdout: string }>("run_git_command", {
					path: repoPath,
					args: ["status", "--porcelain"],
				});
				hasDirtyFiles = status.stdout.trim().length > 0;
			} catch (err) {
				appLogger.warn("git", `Could not check dirty status for ${repoPath}, assuming clean`, err);
			}
			setMergePendingCtx({ repoPath, branchName, baseBranch: targetBranch, hasDirtyFiles });
			// Branch stays in sidebar until the user decides via cleanup dialog
			return;
		}

		deps.setStatusInfo(`Merged ${branchName} into ${targetBranch} (${result.action})`);

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
