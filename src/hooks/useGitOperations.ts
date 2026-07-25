import { open } from "@tauri-apps/plugin-dialog";
import { batch, createSignal } from "solid-js";
import type { DiscoveredProject } from "../components/ImportDialog";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";
import { terminalsStore } from "../stores/terminals";
import { isTauri, rpc } from "../transport";
import type { RepoInfo } from "../types";
import { toSavedTerminals } from "../utils/importSessions";
import { findOrphanTerminals } from "../utils/terminalOrphans";
import { createBranchSelectionCoordinator } from "./git/createBranchSelectionCoordinator";
import { createRepositoryRefreshCoordinator, type PendingCreation } from "./git/createRepositoryRefreshCoordinator";
import { createTerminalWorktreeCoordinator } from "./git/createTerminalWorktreeCoordinator";
import { createWorktreeCreationCoordinator } from "./git/createWorktreeCreationCoordinator";
import { createWorktreeRemovalCoordinator } from "./git/createWorktreeRemovalCoordinator";
import { createWorktreeWorkflowCoordinator } from "./git/createWorktreeWorkflowCoordinator";
import type { RemoveWorktreeResult } from "./useRepository";

/** Dependencies injected into useGitOperations */
export interface GitOperationsDeps {
	repo: {
		getInfo: (path: string) => Promise<{
			path: string;
			name: string;
			initials: string;
			branch: string;
			status: "clean" | "dirty" | "conflict" | "merge" | "not-git" | "unknown";
			is_git_repo: boolean;
		}>;
		getDiffStats: (path: string) => Promise<{ additions: number; deletions: number }>;
		getWorktreePaths: (repoPath: string) => Promise<Record<string, string>>;
		getRepoSummary: (repoPath: string) => Promise<{
			worktree_paths: Record<string, string>;
			merged_branches: string[];
			diff_stats: Record<string, { additions: number; deletions: number }>;
			last_commit_ts: Record<string, number | null>;
		}>;
		getRepoStructure: (repoPath: string) => Promise<{
			worktree_paths: Record<string, string>;
			merged_branches: string[];
		}>;
		getRepoDiffStats: (repoPath: string) => Promise<{
			diff_stats: Record<string, { additions: number; deletions: number }>;
			last_commit_ts: Record<string, number | null>;
		}>;
		removeWorktree: (
			repoPath: string,
			branchName: string,
			deleteBranch: boolean,
			force?: boolean,
		) => Promise<RemoveWorktreeResult | undefined>;
		createWorktree: (
			baseRepo: string,
			branchName: string,
			createBranch?: boolean,
			baseRef?: string,
		) => Promise<{ status: "ok" | "pending"; name: string; path: string; branch: string; base_repo: string }>;
		renameBranch: (repoPath: string, oldName: string, newName: string) => Promise<void>;
		createBranch: (repoPath: string, name: string, startPoint: string | null, checkout: boolean) => Promise<void>;
		generateWorktreeName: (existingNames: string[]) => Promise<string>;
		generateCloneBranchName: (sourceBranch: string, existingNames: string[]) => Promise<string>;
		listBaseRefOptions: (repoPath: string) => Promise<import("./useRepository").BaseRefOption[]>;
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
		listLocalBranches: (repoPath: string) => Promise<string[]>;
		getMergedBranches: (repoPath: string) => Promise<string[]>;
		checkoutRemoteBranch: (repoPath: string, branchName: string) => Promise<void>;
		detectOrphanWorktrees: (repoPath: string) => Promise<string[]>;
		removeOrphanWorktree: (repoPath: string, worktreePath: string) => Promise<void>;
		mergePrViaGithub: (repoPath: string, prNumber: number, mergeMethod: string) => Promise<string>;
		switchBranch: (
			repoPath: string,
			branchName: string,
			opts?: { force?: boolean; stash?: boolean },
		) => Promise<{ success: boolean; stashed: boolean; previous_branch: string; new_branch: string }>;
		runSetupScript: (script: string, cwd: string) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
	};
	pty: {
		canSpawn: () => Promise<boolean>;
		write: (sessionId: string, data: string) => Promise<void>;
		getWorktreesDir: (repoPath?: string) => Promise<string>;
	};
	dialogs: {
		confirmRemoveRepo: (repoName: string) => Promise<boolean>;
		confirmRemoveWorktree: (branchName: string) => Promise<boolean>;
		confirmRemoveLockedWorktree?: (branchName: string, deleteBranch?: boolean) => Promise<boolean>;
		confirmStashAndSwitch?: (branchName: string) => Promise<boolean>;
		confirmOrphanCleanup?: (paths: string[]) => Promise<boolean>;
		/** Surface a git failure in a dialog with the full output; returns true if the user chose Retry. */
		reportGitError?: (title: string, detail: string, offerRetry?: boolean) => Promise<boolean>;
		/** Browser mode only: show an in-app text-input dialog to enter a repo path */
		promptRepoPath?: () => Promise<string | null>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	createNewTerminal: () => Promise<string | undefined>;
	setStatusInfo: (msg: string) => void;
	getDefaultFontSize: () => number;
	getMaxTabNameLength: () => number;
	/** Returns the effective promptOnCreate setting for the given repo.
	 *  When false, handleAddWorktree skips the dialog and creates instantly.
	 *  Defaults to true (show dialog) when not provided. */
	getPromptOnCreate?: (repoPath: string) => boolean;
}

export type { AgentSeed } from "./git/agentSeed";
export { buildAgentSeed, resolveAutofixAgent } from "./git/agentSeed";
/** Git and repository operations extracted from App.tsx */
export function useGitOperations(deps: GitOperationsDeps) {
	const [currentRepoPath, setCurrentRepoPath] = createSignal<string | undefined>(undefined);
	const [currentBranch, setCurrentBranch] = createSignal<string | null>(null);
	const [repoStatus, setRepoStatus] = createSignal<"clean" | "dirty" | "conflict" | "merge" | "unknown">("unknown");
	const [branchToRename, setBranchToRename] = createSignal<{ repoPath: string; branchName: string } | null>(null);
	const [branchToCreate, setBranchToCreate] = createSignal<{ repoPath: string; startPoint: string | null } | null>(
		null,
	);
	const [creatingWorktreeRepos, setCreatingWorktreeRepos] = createSignal<Set<string>>(new Set());
	// Key: `${repoPath}::${branchName}` — prevents concurrent remove calls for same branch
	const [removingBranches, setRemovingBranches] = createSignal<Set<string>>(new Set());

	// Pending creates whose Rust background recreation is still in-flight. When the
	// async create_worktree returned status:'pending', we deferred running the
	// setup script / spawning the initial terminal until the worktree files
	// actually exist. The refresh handler drains this map once `isPreparing` is
	// cleared for a branch (success path). On `worktree-create-failed` (Rust
	// error path) the entry is removed without running setup.
	const pendingCreations = new Map<string, PendingCreation>(); // key: `${repoPath}::${branchName}`
	const pendingKey = (repoPath: string, branchName: string) => `${repoPath}::${branchName}`;
	const [worktreeDialogState, setWorktreeDialogState] = createSignal<{
		repoPath: string;
		suggestedName: string;
		existingBranches: string[];
		worktreeBranches: string[];
		worktreesDir: string;
		baseRefs: import("./useRepository").BaseRefOption[];
	} | null>(null);

	/** Pending merge context — set when afterMerge=ask; cleared once the user picks or skips cleanup */
	const [mergePendingCtx, setMergePendingCtx] = createSignal<{
		repoPath: string;
		branchName: string;
		baseBranch: string;
		hasDirtyFiles: boolean;
	} | null>(null);

	const { markRecentlyCreated, refreshAllBranchStats } = createRepositoryRefreshCoordinator({
		repo: deps.repo,
		dialogs: deps.dialogs,
		closeTerminal: deps.closeTerminal,
		closeTerminalsInWorktree: (worktreePath) => closeTerminalsInWorktree(worktreePath),
		setupNewWorktree: (repoPath, result, displayName, agentSeed) =>
			setupNewWorktree(repoPath, result, displayName, agentSeed),
		setCreatingWorktreeRepos,
		setStatusInfo: deps.setStatusInfo,
		pendingCreations,
		pendingKey,
	});

	const { handleAddTerminalToBranch, handleBranchSelect, handleBranchSelectInner } = createBranchSelectionCoordinator({
		repo: deps.repo,
		pty: deps.pty,
		setStatusInfo: deps.setStatusInfo,
		getDefaultFontSize: deps.getDefaultFontSize,
		setCurrentRepoPath,
		setCurrentBranch,
	});

	const handleRemoveRepo = async (repoPath: string) => {
		const repoState = repositoriesStore.get(repoPath);
		if (!repoState) return;

		const confirmed = await deps.dialogs.confirmRemoveRepo(repoState.displayName);
		if (!confirmed) return;

		for (const branch of Object.values(repoState.branches)) {
			for (const termId of branch.terminals) {
				await deps.closeTerminal(termId, true);
			}
		}

		invoke("stop_repo_watcher", { repoPath }).catch((err) =>
			appLogger.warn("app", `RepoWatcher failed to stop for ${repoPath}`, err),
		);

		repositoriesStore.remove(repoPath);
		repoSettingsStore.remove(repoPath);

		if (currentRepoPath() === repoPath) {
			setCurrentRepoPath(undefined);
			setCurrentBranch(null);
		}

		deps.setStatusInfo(`Removed ${repoState.displayName}`);

		if (terminalsStore.getCount() === 0) {
			await deps.createNewTerminal();
		}
	};

	const { handleRemoveBranch } = createWorktreeRemovalCoordinator({
		repo: deps.repo,
		dialogs: deps.dialogs,
		closeTerminal: deps.closeTerminal,
		setStatusInfo: deps.setStatusInfo,
		removingBranches,
		setRemovingBranches,
	});

	const handleOpenRenameBranchDialog = (repoPath: string, branchName: string) => {
		setBranchToRename({ repoPath, branchName });
	};

	const handleOpenCreateBranchDialog = (repoPath: string, startPoint?: string | null) => {
		setBranchToCreate({ repoPath, startPoint: startPoint ?? null });
	};

	const handleCreateBranch = async (name: string, checkout: boolean) => {
		const target = branchToCreate();
		if (!target) return;

		// Throw on failure so the dialog can surface the error inline.
		await deps.repo.createBranch(target.repoPath, name, target.startPoint, checkout);

		repositoriesStore.setBranch(target.repoPath, name, {});
		if (checkout) setCurrentBranch(name);
		deps.setStatusInfo(`Created branch ${name}${checkout ? " (checked out)" : ""}`);
		void refreshAllBranchStats();
	};

	const handleRenameBranch = async (oldName: string, newName: string) => {
		const branch = branchToRename();
		if (!branch) return;

		try {
			await deps.repo.renameBranch(branch.repoPath, oldName, newName);
		} catch (err) {
			appLogger.error("git", "Failed to rename branch", err);
			deps.setStatusInfo(`Failed to rename branch: ${err}`);
			return;
		}

		repositoriesStore.renameBranch(branch.repoPath, oldName, newName);

		if (currentBranch() === oldName) {
			setCurrentBranch(newName);
		}

		deps.setStatusInfo(`Renamed branch ${oldName} to ${newName}`);
	};

	const activeWorktreePath = () => {
		const activeRepo = repositoriesStore.getActive();
		if (!activeRepo?.activeBranch) return undefined;
		return activeRepo.branches[activeRepo.activeBranch]?.worktreePath || activeRepo.path;
	};

	const activeRunCommand = () => {
		const activeRepo = repositoriesStore.getActive();
		if (!activeRepo?.activeBranch) return undefined;
		return activeRepo.branches[activeRepo.activeBranch]?.runCommand;
	};

	/** Register an existing local folder as a project: repo info, store entry,
	 *  branch/terminal setup, watcher, and branch stats. Shared by the folder
	 *  picker (handleAddRepo) and the clone-from-GitHub flow. */
	const addRepoFromPath = async (path: string) => {
		try {
			const info = await deps.repo.getInfo(path);

			// Close orphan terminals (not associated with any branch)
			const branchTerminalMap: Record<string, string[]> = {};
			for (const repoPath of repositoriesStore.getPaths()) {
				const repoState = repositoriesStore.get(repoPath);
				if (repoState) {
					for (const branch of Object.values(repoState.branches)) {
						branchTerminalMap[`${repoPath}:${branch.name}`] = branch.terminals;
					}
				}
			}
			const orphanTerminals = findOrphanTerminals(terminalsStore.getIds(), branchTerminalMap);

			for (const id of orphanTerminals) {
				await deps.closeTerminal(id, true);
			}

			repositoriesStore.add({
				path: info.path,
				displayName: info.name,
				initials: info.initials,
				isGitRepo: info.is_git_repo,
			});

			if (info.branch) {
				repositoriesStore.setBranch(info.path, info.branch, { worktreePath: info.path });
				repositoriesStore.setActiveBranch(info.path, info.branch);
				await handleAddTerminalToBranch(info.path, info.branch);
			} else if (!info.is_git_repo) {
				// Non-git directory: create a shell entry so the user can open terminals
				const shellBranch = "shell";
				repositoriesStore.setBranch(info.path, shellBranch, {
					worktreePath: info.path,
					isMain: true,
					isShell: true,
				});
				repositoriesStore.setActiveBranch(info.path, shellBranch);
				await handleAddTerminalToBranch(info.path, shellBranch);
			}

			repositoriesStore.setActive(info.path);
			setCurrentRepoPath(info.path);
			setCurrentBranch(info.branch || (!info.is_git_repo ? "shell" : ""));
			setRepoStatus(info.status === "not-git" ? "unknown" : info.status);

			// Start unified repo watcher (covers HEAD, git state, working tree).
			// Also started for non-git directories so a later `git init` is detected
			// (the .git-creation event triggers the non-git→git transition probe).
			invoke("start_repo_watcher", { repoPath: info.path }).catch((err) =>
				appLogger.warn("app", `RepoWatcher failed to start for ${info.path}`, err),
			);

			await refreshAllBranchStats();
		} catch (err) {
			appLogger.error("git", "Failed to add repository", err);
			deps.setStatusInfo(`Failed to add repo: ${err}`);
		}
	};

	const handleAddRepo = async () => {
		let path: string | null = null;

		if (isTauri()) {
			const selected = await open({
				directory: true,
				multiple: false,
				title: "Select Repository Folder",
				defaultPath: repositoriesStore.getActive()?.path ?? "/",
			});
			if (!selected) return;
			path = typeof selected === "string" ? selected : selected[0];
		} else {
			// Browser mode: no native file picker — use in-app text input dialog
			const input = await deps.dialogs.promptRepoPath?.();
			if (!input?.trim()) return;
			path = input.trim();
		}

		if (!path) return;
		await addRepoFromPath(path);
	};

	/** Import projects discovered from other tools (Claude Code / Codex / Cursor /
	 *  superset.sh). Adds each repo without activating it; when includeChats is set,
	 *  discovered chat sessions are stashed as savedTerminals so the first branch
	 *  select lazily restores them with resume commands (see handleBranchSelect). */
	const handleImportProjects = async (selected: DiscoveredProject[], includeChats: boolean) => {
		// Close orphan terminals once up front (mirrors handleAddRepo)
		const branchTerminalMap: Record<string, string[]> = {};
		for (const repoPath of repositoriesStore.getPaths()) {
			const repoState = repositoriesStore.get(repoPath);
			if (repoState) {
				for (const branch of Object.values(repoState.branches)) {
					branchTerminalMap[`${repoPath}:${branch.name}`] = branch.terminals;
				}
			}
		}
		const orphanTerminals = findOrphanTerminals(terminalsStore.getIds(), branchTerminalMap);
		for (const id of orphanTerminals) {
			await deps.closeTerminal(id, true);
		}

		let imported = 0;
		let failed = 0;
		for (const proj of selected) {
			if (repositoriesStore.get(proj.path)) continue; // already added
			try {
				const info = await deps.repo.getInfo(proj.path);

				repositoriesStore.add({
					path: info.path,
					displayName: info.name,
					initials: info.initials,
					isGitRepo: info.is_git_repo,
				});

				const branchName = info.branch || "shell";
				const saved = includeChats ? toSavedTerminals(proj, deps.getDefaultFontSize()) : [];
				repositoriesStore.setBranch(info.path, branchName, {
					worktreePath: info.path,
					// Non-git directories get a shell entry, same as handleAddRepo
					...(info.branch ? {} : { isMain: true, isShell: true }),
					// Do NOT spawn terminals or activate the branch here — savedTerminals
					// are lazily restored (with agent resume) on first branch select.
					...(saved.length > 0 ? { savedTerminals: saved } : {}),
				});

				invoke("start_repo_watcher", { repoPath: info.path }).catch((err) =>
					appLogger.warn("app", `RepoWatcher failed to start for ${info.path}`, err),
				);
				imported++;
			} catch (err) {
				appLogger.error("git", `Failed to import project ${proj.path}`, err);
				failed++;
			}
		}

		await refreshAllBranchStats();
		deps.setStatusInfo(
			failed > 0
				? `Imported ${imported} project${imported === 1 ? "" : "s"} (${failed} failed)`
				: `Imported ${imported} project${imported === 1 ? "" : "s"}`,
		);
	};

	const handleAddRemoteRepo = async (connectionId: string) => {
		// Prompt for remote path
		const input = await deps.dialogs.promptRepoPath?.();
		if (!input?.trim()) return;
		const remotePath = input.trim();

		try {
			// Validate by fetching repo info from remote
			const info = await rpc<RepoInfo>("get_repo_info", { path: remotePath }, connectionId);

			repositoriesStore.add({
				path: info.path,
				displayName: info.name,
				initials: info.initials,
				isGitRepo: info.is_git_repo,
				connectionId,
			});

			if (info.branch) {
				repositoriesStore.setBranch(info.path, info.branch, { worktreePath: info.path });
				repositoriesStore.setActiveBranch(info.path, info.branch);
				await handleAddTerminalToBranch(info.path, info.branch);
			} else if (!info.is_git_repo) {
				const shellBranch = "shell";
				repositoriesStore.setBranch(info.path, shellBranch, {
					worktreePath: info.path,
					isMain: true,
					isShell: true,
				});
				repositoriesStore.setActiveBranch(info.path, shellBranch);
				await handleAddTerminalToBranch(info.path, shellBranch);
			}

			repositoriesStore.setActive(info.path);
		} catch (err) {
			appLogger.error("git", `Failed to add remote repo from ${connectionId}`, err);
			deps.setStatusInfo(`Failed to add remote repo: ${err}`);
		}
	};

	const { confirmCreateWorktree, handleAddWorktree, handleCreateWorktreeFromBranch, setupNewWorktree } =
		createWorktreeCreationCoordinator({
			repo: deps.repo,
			pty: deps.pty,
			getPromptOnCreate: deps.getPromptOnCreate,
			setStatusInfo: deps.setStatusInfo,
			creatingWorktreeRepos,
			setCreatingWorktreeRepos,
			worktreeDialogState,
			setWorktreeDialogState,
			pendingCreations,
			pendingKey,
			markRecentlyCreated,
			handleAddTerminalToBranch,
		});

	const {
		closeTerminalsForBranch,
		closeTerminalsInWorktree,
		dismissMergePending,
		handleAutofixIssue,
		handleConflictAssist,
		handleMergeAndArchive,
	} = createWorktreeWorkflowCoordinator({
		repo: deps.repo,
		closeTerminal: deps.closeTerminal,
		setStatusInfo: deps.setStatusInfo,
		creatingWorktreeRepos,
		setCreatingWorktreeRepos,
		setMergePendingCtx,
		pendingCreations,
		pendingKey,
		markRecentlyCreated,
		setupNewWorktree,
		refreshAllBranchStats,
	});

	const handleNewTab = async () => {
		// Prefer the active terminal's branch registration and CWD as source of truth —
		// the store's activeBranch may be stale if HEAD changed externally and head-changed
		// hasn't been fully processed yet (race between refreshAllBranchStats and setActiveBranch).
		const activeTerminalId = terminalsStore.state.activeId;
		const activeTerminal = activeTerminalId ? terminalsStore.get(activeTerminalId) : null;
		const activeCwd = activeTerminal?.cwd ?? null;

		if (activeCwd) {
			for (const repoPath of repositoriesStore.getPaths()) {
				const repo = repositoriesStore.get(repoPath);
				if (!repo) continue;

				// When multiple branches share the same worktreePath (main checkout after HEAD move),
				// prefer the branch that owns the active terminal — it reflects the partially-processed
				// head-changed state more accurately than insertion-order iteration.
				if (activeTerminalId) {
					const ownerEntry = Object.entries(repo.branches).find(
						([, b]) => b.worktreePath === activeCwd && b.terminals.includes(activeTerminalId),
					);
					if (ownerEntry) {
						await handleAddTerminalToBranch(repoPath, ownerEntry[0]);
						return;
					}
				}

				// Linked worktree: unique worktreePath per branch, unambiguous match
				const match = Object.values(repo.branches).find((b) => b.worktreePath && b.worktreePath === activeCwd);
				if (match) {
					await handleAddTerminalToBranch(repoPath, match.name);
					return;
				}
			}
		}

		// Fall back to store's active branch (no active terminal or no CWD match)
		const activeRepo = repositoriesStore.getActive();
		if (activeRepo?.activeBranch) {
			await handleAddTerminalToBranch(activeRepo.path, activeRepo.activeBranch);
		} else {
			await deps.createNewTerminal();
		}
	};

	const handleRunCommand = (forceDialog: boolean, openDialog: () => void) => {
		const savedCmd = activeRunCommand();
		if (savedCmd && !forceDialog) {
			executeRunCommand(savedCmd);
		} else {
			openDialog();
		}
	};

	const executeRunCommand = async (command: string) => {
		const activeRepo = repositoriesStore.getActive();
		if (!activeRepo?.activeBranch) return;

		repositoriesStore.setRunCommand(activeRepo.path, activeRepo.activeBranch, command);

		const canSpawn = await deps.pty.canSpawn();
		if (!canSpawn) {
			deps.setStatusInfo("Max sessions reached (50)");
			return;
		}

		const branch = activeRepo.branches[activeRepo.activeBranch];
		const cwd = branch?.worktreePath || activeRepo.path;
		const maxNameLen = deps.getMaxTabNameLength();
		const tabName = command.length > maxNameLen ? command.slice(0, maxNameLen) + "..." : command;

		const id = terminalsStore.add({
			sessionId: null,
			fontSize: deps.getDefaultFontSize(),
			name: tabName,
			cwd,
			awaitingInput: null,
		});

		terminalsStore.setActive(id);
		repositoriesStore.addTerminalToBranch(activeRepo.path, activeRepo.activeBranch, id);

		let waitAttempts = 0;
		const waitForSession = setInterval(async () => {
			waitAttempts++;
			const terminal = terminalsStore.get(id);
			if (terminal?.sessionId) {
				clearInterval(waitForSession);
				try {
					await deps.pty.write(terminal.sessionId, command + "\n");
				} catch (err) {
					appLogger.error("terminal", "Failed to send run command", err);
				}
			} else if (waitAttempts >= 20) {
				clearInterval(waitForSession);
				appLogger.warn("terminal", "Timed out waiting for session on run command");
			}
		}, 500);
	};

	const generateWorktreeName = async (): Promise<string> => {
		const state = worktreeDialogState();
		const worktreeBranches = state?.worktreeBranches ?? [];
		return deps.repo.generateWorktreeName(worktreeBranches);
	};

	const handleRepoSettings = (
		repoPath: string,
		openSettingsPanel: (context: { kind: "repo"; repoPath: string }) => void,
	) => {
		setCurrentRepoPath(repoPath);
		openSettingsPanel({ kind: "repo", repoPath });
	};

	// --- Branch switching ---

	const [switchBranchLists, setSwitchBranchLists] = createSignal<Record<string, string[]>>({});
	const [currentBranches, setCurrentBranches] = createSignal<Record<string, string>>({});

	/** Refresh the local branch list and current branch for all git repos (for context menu). */
	const refreshBranchLists = async (scopeRepoPath?: string) => {
		const repos = repositoriesStore
			.getOrderedRepos()
			.filter((r) => r.isGitRepo !== false)
			.filter((r) => !scopeRepoPath || r.path === scopeRepoPath);
		const results: Record<string, string[]> = {};
		const heads: Record<string, string> = {};
		await Promise.all(
			repos.map(async (r) => {
				try {
					const [branches, info] = await Promise.all([deps.repo.listLocalBranches(r.path), deps.repo.getInfo(r.path)]);
					results[r.path] = branches;
					heads[r.path] = info.branch;
				} catch (e) {
					appLogger.debug("git", "Skipping repo in branch listing", { path: r.path, error: String(e) });
				}
			}),
		);
		// Scoped refresh merges into the existing maps so the other repos'
		// dropdown lists aren't wiped; a full refresh replaces wholesale.
		if (scopeRepoPath) {
			setSwitchBranchLists((prev) => ({ ...prev, ...results }));
			setCurrentBranches((prev) => ({ ...prev, ...heads }));
		} else {
			setSwitchBranchLists(results);
			setCurrentBranches(heads);
		}
	};

	// Compose branch stats + branch list refresh into a single function
	const refreshAllBranchStatsAndLists = async (scopeRepoPath?: string) => {
		await refreshAllBranchStats(scopeRepoPath);
		await refreshBranchLists(scopeRepoPath);
	};

	/** After a branch switch on the main worktree, migrate all stale branch entries
	 *  (same worktreePath as repoPath) into the new branch and remove them. */
	const migrateMainWorktreeBranches = (repoPath: string, newBranch: string) => {
		const repo = repositoriesStore.get(repoPath);
		if (!repo) return;

		// Ensure the target branch entry exists
		repositoriesStore.setBranch(repoPath, newBranch, { worktreePath: repoPath });

		// Find all branches on the main worktree that aren't the new branch
		const stale = Object.values(repo.branches).filter((b) => b.worktreePath === repoPath && b.name !== newBranch);

		batch(() => {
			for (const branch of stale) {
				repositoriesStore.mergeBranchState(repoPath, branch.name, newBranch);
				repositoriesStore.removeBranch(repoPath, branch.name);
			}
			repositoriesStore.setActiveBranch(repoPath, newBranch);
		});
	};

	/** Handle branch switch request from sidebar. Checks terminal safety, then calls Rust. */
	const handleSwitchBranch = async (repoPath: string, branchName: string) => {
		const repo = repositoriesStore.get(repoPath);
		if (!repo) return;

		// Pre-flight: check for busy terminals on the main worktree
		const mainWorktreeBranches = Object.values(repo.branches).filter((b) => b.worktreePath === repoPath);
		for (const branch of mainWorktreeBranches) {
			for (const termId of branch.terminals) {
				const term = terminalsStore.get(termId);
				if (term?.shellState === "busy") {
					deps.setStatusInfo(`Cannot switch branch: terminal "${term.name || termId}" has a running process`);
					return;
				}
			}
		}

		// git stderr that means a stale/contended index.lock — these are recoverable
		// (the lock is auto-cleared once stale), so the error dialog offers a retry.
		const isLockError = (msg: string) => /index\.lock|could not write index|another git process/i.test(msg);

		// Stash + switch, then migrate branch entries and refresh. Throws on failure.
		const stashAndSwitch = async () => {
			const result = await deps.repo.switchBranch(repoPath, branchName, { stash: true });
			deps.setStatusInfo(`Switched to ${result.new_branch} (changes stashed)`);
			migrateMainWorktreeBranches(repoPath, result.new_branch);
			await refreshAllBranchStatsAndLists();
		};

		try {
			const result = await deps.repo.switchBranch(repoPath, branchName);
			if (result.stashed) {
				deps.setStatusInfo(`Switched to ${result.new_branch} (changes stashed)`);
			} else {
				deps.setStatusInfo(`Switched to ${result.new_branch}`);
			}
			// Migrate all main-worktree branches into the new branch entry, then remove stale ones
			migrateMainWorktreeBranches(repoPath, result.new_branch);
			// Refresh branch stats to pick up the new HEAD
			await refreshAllBranchStatsAndLists();
		} catch (err) {
			const errMsg = String(err);
			if (errMsg === "dirty" || errMsg.includes("dirty")) {
				// Dirty working tree — ask user to stash
				const confirmed = await deps.dialogs.confirmStashAndSwitch?.(branchName);
				if (!confirmed) return;
				try {
					await stashAndSwitch();
				} catch (stashErr) {
					const msg = String(stashErr);
					appLogger.error("git", "Stash & switch failed", { repoPath, branchName, error: msg });
					const lock = isLockError(msg);
					const detail = lock
						? `A stale git lock is blocking the index:\n\n${msg}\n\nStale locks clear automatically after a short while. Retry?`
						: msg;
					const retry = await deps.dialogs.reportGitError?.("Stash & switch failed", detail, lock);
					if (!retry) return;
					try {
						await stashAndSwitch();
					} catch (retryErr) {
						const retryMsg = String(retryErr);
						appLogger.error("git", "Stash & switch retry failed", { repoPath, branchName, error: retryMsg });
						await deps.dialogs.reportGitError?.("Stash & switch failed again", retryMsg, false);
					}
				}
			} else {
				appLogger.error("git", "Branch switch failed", { repoPath, branchName, error: errMsg });
				await deps.dialogs.reportGitError?.("Branch switch failed", errMsg, false);
			}
		}
	};

	const handleCheckoutRemoteBranch = async (repoPath: string, branchName: string) => {
		try {
			await deps.repo.checkoutRemoteBranch(repoPath, branchName);
			deps.setStatusInfo(`Checked out ${branchName}`);
			migrateMainWorktreeBranches(repoPath, branchName);
			await refreshAllBranchStatsAndLists();
			await handleBranchSelectInner(repoPath, branchName);
		} catch (err) {
			appLogger.error("git", "Failed to checkout remote branch", { error: String(err) });
			deps.setStatusInfo(`Checkout failed: ${err}`);
		}
	};

	const { cancelCwdTracking, getWorktreeTargets, handleTerminalCwdChange, moveTerminalToWorktree } =
		createTerminalWorktreeCoordinator({
			refreshBranches: refreshAllBranchStats,
			setCurrentBranch,
			setCurrentRepoPath,
			writePty: deps.pty.write,
		});

	/** Handle the `worktree-create-failed` event emitted by the Rust background
	 *  recreate task. Drops the pending creation (no setup), removes the
	 *  placeholder from the store, releases the per-repo create lock, and
	 *  surfaces the error to the user. */
	const handleWorktreeCreateFailed = (payload: { repoPath: string; branch: string; reason: string }) => {
		const { repoPath, branch, reason } = payload;
		appLogger.error("git", `Worktree creation failed`, payload);
		pendingCreations.delete(pendingKey(repoPath, branch));
		repositoriesStore.removeBranch(repoPath, branch);
		setCreatingWorktreeRepos((prev) => {
			const next = new Set(prev);
			next.delete(repoPath);
			return next;
		});
		deps.setStatusInfo(`Failed to create worktree ${branch}: ${reason}`);
	};

	return {
		currentRepoPath,
		setCurrentRepoPath,
		currentBranch,
		setCurrentBranch,
		repoStatus,
		setRepoStatus,
		branchToRename,
		setBranchToRename,
		refreshAllBranchStats: refreshAllBranchStatsAndLists,
		handleBranchSelect,
		handleAddTerminalToBranch,
		handleRemoveRepo,
		handleRemoveBranch,
		handleOpenRenameBranchDialog,
		handleRenameBranch,
		branchToCreate,
		setBranchToCreate,
		handleOpenCreateBranchDialog,
		handleCreateBranch,
		activeWorktreePath,
		activeRunCommand,
		handleAddRepo,
		addRepoFromPath,
		handleImportProjects,
		handleAddRemoteRepo,
		handleAddWorktree,
		confirmCreateWorktree,
		handleCreateWorktreeFromBranch,
		handleAutofixIssue,
		handleConflictAssist,
		handleMergeAndArchive,
		mergePendingCtx,
		dismissMergePending,
		closeTerminalsForBranch,
		worktreeDialogState,
		setWorktreeDialogState,
		creatingWorktreeRepos,
		removingBranches,
		handleWorktreeCreateFailed,
		handleNewTab,
		handleRunCommand,
		executeRunCommand,
		generateWorktreeName,
		handleRepoSettings,
		handleCheckoutRemoteBranch,
		handleSwitchBranch,
		handleTerminalCwdChange,
		cancelCwdTracking,
		switchBranchLists,
		currentBranches,
		refreshBranchLists,
		getWorktreeTargets,
		moveTerminalToWorktree,
		/** Create a new terminal for the branch and queue the review command */
		handleReviewPr: async (repoPath: string, branchName: string, command: string) => {
			const termId = await handleAddTerminalToBranch(repoPath, branchName);
			if (termId) {
				terminalsStore.update(termId, { pendingInitCommand: command });
			}
		},
	};
}
