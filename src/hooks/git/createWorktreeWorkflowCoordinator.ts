import type { Accessor, Setter } from "solid-js";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { autofixBranchName } from "../../stores/autofix";
import { githubStore } from "../../stores/github";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { closeWorktreeTerminals, removeWorktreeWorkspace } from "../../stores/terminalOwnership";
import type { WorkspaceLifecycleStatus } from "../../stores/workspaceIdentity";
import { effectiveMergeMethod, isMergeHeadChanged, isMergeMethodNotAllowed } from "../../utils/prMerge";
import { reportActionError } from "../../utils/reportActionError";
import { type AgentSeed, buildAgentSeed } from "./agentSeed";
import type { PendingCreation } from "./createRepositoryRefreshCoordinator";
import { bindStartWork, createStartWork } from "./startWork";

interface WorktreeWorkflowCoordinatorDeps {
	repo: {
		getWorkspaceLifecycle: (repoPath: string, workspaceId: string) => Promise<WorkspaceLifecycleStatus>;
		listBaseRefOptions: (repoPath: string) => Promise<Array<{ name: string; is_default?: boolean }>>;
		createWorktree: (
			baseRepo: string,
			branchName: string,
			createBranch?: boolean,
			baseRef?: string,
		) => Promise<PendingCreation["result"] & { status: "ok" }>;
		mergePrViaGithub: (
			repoPath: string,
			prNumber: number,
			mergeMethod: string,
			expectedHeadSha: string,
		) => Promise<string>;
		mergeAndArchiveWorktree: (
			repoPath: string,
			branchName: string,
			workspaceId: string,
			targetBranch: string,
			afterMerge: string,
			force?: boolean,
			expectedFingerprint?: string,
		) => Promise<{
			merged: boolean;
			action: string;
			archive_path: string | null;
			commits_ahead?: number;
			worktree_dirty?: boolean;
		}>;
		finalizeMergedWorktree: (
			repoPath: string,
			workspaceId: string,
			action: "archive" | "delete",
			force?: boolean,
			expectedFingerprint?: string,
		) => Promise<{ merged: boolean; action: string; archive_path: string | null }>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	setStatusInfo: (message: string) => void;
	/** Ask the user to confirm a cleanup that would destroy the worktree's
	 *  uncommitted work. Resolves false to abort. */
	confirmDirtyWorktreeCleanup: (
		branchName: string,
		action: string,
		commitsAhead: number,
		lifecycle?: WorkspaceLifecycleStatus,
	) => Promise<boolean>;
	creatingWorktreeRepos: Accessor<Set<string>>;
	setCreatingWorktreeRepos: Setter<Set<string>>;
	setMergePendingCtx: Setter<{
		repoPath: string;
		/** The row being cleaned up. */
		workspaceId: string;
		/** The ref being merged and deleted — a different object from the row. */
		branchName: string;
		baseBranch: string;
		hasDirtyFiles: boolean;
		worktreeDirty: boolean;
		removalWarnings?: string[];
		worktreeFingerprint?: string;
		submoduleUnpushedCommits?: Array<{ path: string; count: number }>;
	} | null>;
	setupNewWorktree: (
		repoPath: string,
		result: PendingCreation["result"],
		displayName: string,
		agentSeed?: AgentSeed,
	) => Promise<string | undefined>;
	refreshAllBranchStats: (repoPath: string) => Promise<void>;
}

/** Owns start work (auto-fix included), conflict assist, merge, and post-merge cleanup workflows. */
export function createWorktreeWorkflowCoordinator(deps: WorktreeWorkflowCoordinatorDeps) {
	const {
		creatingWorktreeRepos,
		setCreatingWorktreeRepos,
		setMergePendingCtx,
		setupNewWorktree,
		refreshAllBranchStats,
	} = deps;

	const handleStartWork = createStartWork({
		listBaseRefOptions: (repoPath) => deps.repo.listBaseRefOptions(repoPath),
		createWorktree: (...args) => deps.repo.createWorktree(...args),
		setupNewWorktree,
		setStatusInfo: deps.setStatusInfo,
		creatingWorktreeRepos,
		setCreatingWorktreeRepos,
	});
	bindStartWork(handleStartWork);

	/** Auto-fix an issue: start work on a fresh `autofix/issue-<n>` worktree off
	 *  the default branch. The user confirmed `prompt` in the auto-fix dialog, so
	 *  it is submitted rather than left as a draft. */
	const handleAutofixIssue = async (repoPath: string, issueNumber: number, prompt: string) => {
		if (creatingWorktreeRepos().has(repoPath)) return;
		try {
			await handleStartWork({ repoPath, branch: autofixBranchName(issueNumber), prompt, delivery: "submit" });
		} catch (err) {
			appLogger.error("git", "Failed to create auto-fix worktree", err);
			deps.setStatusInfo(`Failed to create auto-fix worktree: ${err}`);
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
				{
					name: result.branch,
					path: result.worktree_path,
					// `start_conflict_assist` creates a linked worktree, whose id is its
					// branch by the identity migration. It is spelled out here rather
					// than left to `setupNewWorktree` so the id has exactly one source
					// per creation path.
					workspace_id: result.branch,
					branch: result.branch,
					base_repo: repoPath,
				},
				result.branch,
				await buildAgentSeed(result.prompt, repoPath),
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

	/** All cleanup entry points share the same cwd-based close authority. */
	const closeTerminalsInWorktree = (worktreePath: string) => closeWorktreeTerminals(worktreePath, deps.closeTerminal);

	const closeTerminalsForBranch = async (repoPath: string, workspaceId: string) => {
		const worktreePath = repositoriesStore.get(repoPath)?.workspaces[workspaceId]?.worktreePath;
		if (worktreePath) await closeTerminalsInWorktree(worktreePath);
	};

	/** Merge one workspace's branch into `targetBranch`, then dispose of that
	 *  workspace. Two objects, two identifiers: `workspaceId` is the row and the
	 *  checkout, and the branch it has checked out — read off the record — is the
	 *  merge subject, the PR key and the ref to delete. */
	const handleMergeAndArchive = async (
		repoPath: string,
		workspaceId: string,
		targetBranch: string,
		afterMerge: string,
	) => {
		const branchName = repositoriesStore.branchNameFor(repoPath, workspaceId);
		try {
			deps.setStatusInfo(`Merging ${branchName} into ${targetBranch}...`);

			// Use GitHub API when a PR exists for this branch
			const pr = githubStore.getPrStatus(repoPath, branchName);
			if (pr && pr.state === "OPEN") {
				const preferred = repoSettingsStore.getEffective(repoPath)?.prMergeStrategy ?? "merge";
				const method = effectiveMergeMethod(pr, preferred);
				// No head sha means no pin: refuse here instead of falling back to a local merge of unreviewed commits.
				if (!pr.head_ref_oid?.trim()) {
					throw new Error("PR head changed: the PR head commit is unknown. Refresh and review before merging.");
				}
				try {
					await deps.repo.mergePrViaGithub(repoPath, pr.number, method, pr.head_ref_oid);
				} catch (githubErr) {
					if (isMergeMethodNotAllowed(githubErr) || isMergeHeadChanged(githubErr)) {
						// Surface 405 (branch protection disallows the method) and head-moved (unreviewed
						// commits: a local merge would include them too) to the caller
						throw githubErr;
					}
					// Other GitHub API failures — fall back to local git merge
					appLogger.warn("git", `GitHub API merge failed, falling back to local git merge: ${githubErr}`);
					await mergeLocalAndFinalize(repoPath, workspaceId, targetBranch, afterMerge);
					return;
				}
				// GitHub merge succeeded — close terminals and finalize the worktree locally
				await closeTerminalsForBranch(repoPath, workspaceId);
				if (afterMerge === "ask") {
					deps.setStatusInfo(`Merged ${branchName} via GitHub — choose what to do with the worktree`);
					await openCleanupDialog(repoPath, workspaceId, targetBranch);
					return;
				}
				const action = afterMerge as "archive" | "delete";
				if (!(await finalizeWithConfirmation(repoPath, workspaceId, action))) {
					deps.setStatusInfo(`Merged ${branchName} via GitHub — worktree kept`);
					await refreshAllBranchStats(repoPath);
					return;
				}
				deps.setStatusInfo(`Merged ${branchName} via GitHub (${action === "archive" ? "archived" : "deleted"})`);
				removeWorktreeWorkspace(repoPath, workspaceId);
				await refreshAllBranchStats(repoPath);
				return;
			}

			// No open PR — local git merge
			await mergeLocalAndFinalize(repoPath, workspaceId, targetBranch, afterMerge);
		} catch (err) {
			if (isMergeMethodNotAllowed(err)) {
				throw err;
			}
			appLogger.error("git", "Failed to merge and archive worktree", err);
			reportActionError(deps.setStatusInfo, `Failed to merge: ${err}`);
		}
	};

	/** Merge a workspace into the repo's main branch with the repo's after-merge setting.
	 *  Shared by the sidebar and branch-menu Merge & Archive entries. */
	const handleMergeAndArchiveIntoMain = async (repoPath: string, workspaceId: string) => {
		const repoState = repositoriesStore.get(repoPath);
		const mainBranch = repoState ? Object.values(repoState.workspaces).find((b) => b.isMain)?.branchName : undefined;
		if (!mainBranch) {
			reportActionError(deps.setStatusInfo, "Cannot merge: no main branch found");
			return;
		}
		const afterMerge = repoSettingsStore.getEffective(repoPath)?.afterMerge ?? "archive";
		await handleMergeAndArchive(repoPath, workspaceId, mainBranch, afterMerge);
	};

	/** Collect everything the post-merge cleanup dialog needs to warn honestly.
	 *
	 *  Two different directories, two different warnings:
	 *  - `hasDirtyFiles` is the BASE repo — the "Switch to <base>" step stashes it.
	 *  - `worktreeDirty` is the BRANCH's worktree — the "Archive/Delete worktree"
	 *    step ends in `git worktree remove --force` and would take it for good.
	 *  Either check failing is reported as dirty: an unanswered question must not
	 *  read as "nothing to lose" when it gates a destructive step. */
	const openCleanupDialog = async (repoPath: string, workspaceId: string, baseBranch: string) => {
		const branchName = repositoriesStore.branchNameFor(repoPath, workspaceId);
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
		let worktreeFingerprint: string | undefined;
		let submoduleUnpushedCommits: Array<{ path: string; count: number }> | undefined;
		let removalWarnings: string[] | undefined;
		try {
			worktreeDirty = await invoke<boolean>("check_worktree_dirty", { repoPath, workspaceId });
		} catch (err) {
			appLogger.warn("git", `Could not check the ${branchName} worktree, assuming dirty`, err);
			worktreeDirty = true;
		}
		try {
			const lifecycle = await deps.repo.getWorkspaceLifecycle(repoPath, workspaceId);
			worktreeFingerprint = lifecycle.dirtyFingerprint;
			submoduleUnpushedCommits = lifecycle.submoduleUnpushedCommits;
			removalWarnings = lifecycle.warnings;
		} catch (err) {
			appLogger.warn("git", `Could not fingerprint the ${branchName} worktree`, err);
		}

		setMergePendingCtx({
			repoPath,
			workspaceId,
			branchName,
			baseBranch,
			hasDirtyFiles,
			worktreeDirty,
			...(removalWarnings ? { removalWarnings } : {}),
			...(worktreeFingerprint ? { worktreeFingerprint } : {}),
			...(submoduleUnpushedCommits ? { submoduleUnpushedCommits } : {}),
		});
	};

	/** Archive/delete a merged worktree, asking first when the backend refuses.
	 *  Returns false when the user declined and the worktree is still on disk. */
	const finalizeWithConfirmation = async (repoPath: string, workspaceId: string, action: "archive" | "delete") => {
		const result = await deps.repo.finalizeMergedWorktree(repoPath, workspaceId, action);
		if (result.action !== "needs_confirmation") return true;

		// The merge already landed; only the cleanup stopped. Nothing is lost yet.
		// The dialog names the branch, because that is what the user recognises.
		const branchName = repositoriesStore.branchNameFor(repoPath, workspaceId);
		const lifecycle = await deps.repo.getWorkspaceLifecycle(repoPath, workspaceId);
		if (!lifecycle.dirtyFingerprint) throw new Error("Cannot verify worktree state before force confirmation");
		if (!(await deps.confirmDirtyWorktreeCleanup(branchName, action, 0, lifecycle))) return false;
		await deps.repo.finalizeMergedWorktree(repoPath, workspaceId, action, true, lifecycle.dirtyFingerprint);
		return true;
	};

	/** Local git merge path: checkout target, merge, then archive/delete/ask. */
	const mergeLocalAndFinalize = async (
		repoPath: string,
		workspaceId: string,
		targetBranch: string,
		afterMerge: string,
	) => {
		// Two parameters because two objects: the branch is the merge subject, the id
		// is the checkout to dispose of afterwards. The backend refuses when they
		// disagree rather than guessing which one the caller meant.
		const branchName = repositoriesStore.branchNameFor(repoPath, workspaceId);
		let result = await deps.repo.mergeAndArchiveWorktree(repoPath, branchName, workspaceId, targetBranch, afterMerge);

		// The backend refused: the worktree is not known to be clean, so archiving or
		// deleting it would make the row vanish and take that uncommitted work with
		// it. Neither the merge nor the cleanup has run — ask, then retry with force.
		if (result.action === "needs_confirmation") {
			const lifecycle = await deps.repo.getWorkspaceLifecycle(repoPath, workspaceId);
			if (!lifecycle.dirtyFingerprint) throw new Error("Cannot verify worktree state before force confirmation");
			const proceed = await deps.confirmDirtyWorktreeCleanup(
				branchName,
				afterMerge,
				result.commits_ahead ?? 0,
				lifecycle,
			);
			if (!proceed) {
				deps.setStatusInfo(`Left ${branchName} alone — its worktree needs review`);
				return;
			}
			result = await deps.repo.mergeAndArchiveWorktree(
				repoPath,
				branchName,
				workspaceId,
				targetBranch,
				afterMerge,
				true,
				lifecycle.dirtyFingerprint,
			);
		}

		// Merge succeeded — close terminals now (not before, to avoid orphaning the branch on failure)
		await closeTerminalsForBranch(repoPath, workspaceId);

		if (result.action === "pending") {
			// "ask" mode — merge succeeded, user must choose what to do with the worktree
			deps.setStatusInfo(`Merged ${branchName} into ${targetBranch} — choose what to do with the worktree`);
			await openCleanupDialog(repoPath, workspaceId, targetBranch);
			// Branch stays in sidebar until the user decides via cleanup dialog
			return;
		}

		// Say what the merge actually did. "Already up to date" and "brought 7 commits
		// across" both end here with action=archived, and the row disappears either
		// way — without the count the user cannot tell an empty branch from a real one.
		const ahead = result.commits_ahead ?? 0;
		const carried = ahead === 0 ? "nothing to merge" : `${ahead} commit${ahead === 1 ? "" : "s"}`;
		deps.setStatusInfo(`${branchName} → ${targetBranch}: ${carried} (${result.action})`);

		// Drop the row from the sidebar
		removeWorktreeWorkspace(repoPath, workspaceId);

		// Refresh to pick up updated branch stats
		await refreshAllBranchStats(repoPath);
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
		handleMergeAndArchiveIntoMain,
		handleStartWork,
	};
}
