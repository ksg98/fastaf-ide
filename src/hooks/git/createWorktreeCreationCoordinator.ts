import type { Accessor, Setter } from "solid-js";
import { AGENTS } from "../../agents";
import type { WorktreeCreateOptions } from "../../components/CreateWorktreeDialog";
import { appLogger } from "../../stores/appLogger";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { reportActionError } from "../../utils/reportActionError";
import type { BaseRefOption } from "../useRepository";
import type { AgentSeed } from "./agentSeed";
import type { PendingCreation } from "./createRepositoryRefreshCoordinator";

export interface WorktreeDialogState {
	repoPath: string;
	suggestedName: string;
	existingBranches: string[];
	worktreeBranches: string[];
	worktreesDir: string;
	baseRefs: BaseRefOption[];
}

interface WorktreeCreationCoordinatorDeps {
	repo: {
		generateWorktreeName: (existingNames: string[]) => Promise<string>;
		generateCloneBranchName: (sourceBranch: string, existingNames: string[]) => Promise<string>;
		listLocalBranches: (repoPath: string) => Promise<string[]>;
		listBaseRefOptions: (repoPath: string) => Promise<BaseRefOption[]>;
		createWorktree: (
			baseRepo: string,
			branchName: string,
			createBranch?: boolean,
			baseRef?: string,
		) => Promise<PendingCreation["result"] & { status: "ok" }>;
		runSetupScript: (script: string, cwd: string) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
		getDiffStats: (path: string) => Promise<{ additions: number; deletions: number }>;
	};
	pty: {
		getWorktreesDir: (repoPath?: string) => Promise<string>;
	};
	getPromptOnCreate?: (repoPath: string) => boolean;
	setStatusInfo: (message: string) => void;
	creatingWorktreeRepos: Accessor<Set<string>>;
	setCreatingWorktreeRepos: Setter<Set<string>>;
	worktreeDialogState: Accessor<WorktreeDialogState | null>;
	setWorktreeDialogState: Setter<WorktreeDialogState | null>;
	markRecentlyCreated: (repoPath: string, workspaceId: string) => void;
	handleAddTerminalToWorkspace: (repoPath: string, workspaceId: string) => Promise<string | undefined>;
}

/** Owns worktree creation, setup, and initial terminal seeding. */
export function createWorktreeCreationCoordinator(deps: WorktreeCreationCoordinatorDeps) {
	const {
		creatingWorktreeRepos,
		setCreatingWorktreeRepos,
		worktreeDialogState,
		setWorktreeDialogState,
		markRecentlyCreated,
		handleAddTerminalToWorkspace,
	} = deps;

	const handleAddWorktree = async (repoPath: string) => {
		// Prevent concurrent creations for the same repo
		if (creatingWorktreeRepos().has(repoPath)) return;

		const repoState = repositoriesStore.get(repoPath);
		const worktreeBranches = repoState ? Object.keys(repoState.workspaces) : [];

		// Fetch data for the dialog in parallel
		const [suggestedName, localBranches, worktreesDir, baseRefs] = await Promise.all([
			deps.repo.generateWorktreeName(worktreeBranches),
			deps.repo.listLocalBranches(repoPath),
			deps.pty.getWorktreesDir(repoPath),
			deps.repo.listBaseRefOptions(repoPath),
		]);

		const promptOnCreate = deps.getPromptOnCreate?.(repoPath) ?? true;

		if (!promptOnCreate) {
			// Skip dialog: create worktree instantly with auto-generated name
			setWorktreeDialogState({
				repoPath,
				suggestedName,
				existingBranches: localBranches,
				worktreeBranches,
				worktreesDir,
				baseRefs,
			});
			await confirmCreateWorktree({
				branchName: suggestedName,
				createBranch: true,
				baseRef: baseRefs[0]?.name ?? "HEAD",
			});
			return;
		}

		setWorktreeDialogState({
			repoPath,
			suggestedName,
			existingBranches: localBranches,
			worktreeBranches,
			worktreesDir,
			baseRefs,
		});
	};

	/** Shared post-creation setup: run scripts, open terminal, fetch stats */
	const setupNewWorktree = async (
		repoPath: string,
		result: PendingCreation["result"],
		displayName: string,
		agentSeed?: AgentSeed,
	): Promise<string | undefined> => {
		// Keyed by the id the backend reported; `branch` is display data.
		markRecentlyCreated(repoPath, result.workspace_id);
		repositoriesStore.setWorkspace(repoPath, result.workspace_id, {
			branchName: result.branch,
			worktreePath: result.path,
			kind: result.kind ?? "worktree",
			parentRepoPath: null,
		});
		repositoriesStore.setActiveWorkspace(repoPath, result.workspace_id);

		const effective = repoSettingsStore.getEffective(repoPath);
		if (effective?.setupScript) {
			try {
				deps.setStatusInfo(`Running setup script in ${displayName}...`);
				const scriptResult = await deps.repo.runSetupScript(effective.setupScript, result.path);
				if (scriptResult.exit_code !== 0) {
					appLogger.warn("git", `Setup script failed (exit ${scriptResult.exit_code})`, scriptResult.stderr);
					reportActionError(deps.setStatusInfo, `Setup script failed (exit ${scriptResult.exit_code})`);
				}
			} catch (err) {
				appLogger.warn("git", "Setup script execution error", err);
				reportActionError(deps.setStatusInfo, `Setup script failed: ${err}`);
			}
		}

		const termId = await handleAddTerminalToWorkspace(repoPath, result.workspace_id);

		// Seed must be applied HERE (synchronously after terminal creation, before
		// the getDiffStats await below) — Terminal.tsx reads agentType/pendingInitCommand
		// when it creates the PTY (passes agent_type only if pendingInitCommand is set),
		// which fires on the next rAF. Setting it after setupNewWorktree returns would
		// race that rAF. Same proven window the runScript branch uses.
		if (termId && agentSeed) {
			terminalsStore.update(termId, {
				agentType: agentSeed.agentType,
				pendingInitCommand: agentSeed.initCommand,
				agentLaunchCommand: agentSeed.launchCommand,
				name: AGENTS[agentSeed.agentType].name,
				nameIsCustom: true,
			});
		} else if (termId && effective?.runScript) {
			terminalsStore.update(termId, { pendingInitCommand: effective.runScript });
		}

		try {
			const stats = await deps.repo.getDiffStats(result.path);
			repositoriesStore.updateWorkspaceStats(repoPath, result.workspace_id, stats.additions, stats.deletions);
		} catch (err) {
			appLogger.debug("git", `getDiffStats failed for ${result.branch}`, err);
		}

		deps.setStatusInfo(`Created worktree ${displayName}`);
		return termId;
	};

	const confirmCreateWorktree = async (options: WorktreeCreateOptions) => {
		const dialogState = worktreeDialogState();
		if (!dialogState) return;

		const { repoPath } = dialogState;

		if (creatingWorktreeRepos().has(repoPath)) return;
		setCreatingWorktreeRepos((prev) => new Set([...prev, repoPath]));

		try {
			deps.setStatusInfo(`Creating worktree ${options.branchName}...`);
			const result = await deps.repo.createWorktree(
				repoPath,
				options.branchName,
				options.createBranch,
				options.baseRef,
			);

			setWorktreeDialogState(null);

			await setupNewWorktree(repoPath, result, options.branchName);
		} catch (err) {
			appLogger.error("git", "Failed to create worktree", err);
			deps.setStatusInfo(`Failed to create worktree: ${err}`);
			// Re-throw so the dialog can show the error and stay open
			throw err;
		} finally {
			setCreatingWorktreeRepos((prev) => {
				const next = new Set(prev);
				next.delete(repoPath);
				return next;
			});
		}
	};

	/** Quick-clone flow: right-click branch → instant worktree with hybrid name */
	const handleCreateWorktreeFromBranch = async (repoPath: string, branchName: string) => {
		if (creatingWorktreeRepos().has(repoPath)) return;
		setCreatingWorktreeRepos((prev) => new Set([...prev, repoPath]));

		try {
			const repoState = repositoriesStore.get(repoPath);
			const existingBranches = repoState ? Object.keys(repoState.workspaces) : [];
			const cloneName = await deps.repo.generateCloneBranchName(branchName, existingBranches);

			deps.setStatusInfo(`Creating worktree ${cloneName}...`);
			const result = await deps.repo.createWorktree(repoPath, cloneName, true, branchName);

			await setupNewWorktree(repoPath, result, cloneName);
		} catch (err) {
			appLogger.error("git", "Failed to create worktree from branch", err);
			reportActionError(deps.setStatusInfo, `Failed to create worktree: ${err}`);
		} finally {
			setCreatingWorktreeRepos((prev) => {
				const next = new Set(prev);
				next.delete(repoPath);
				return next;
			});
		}
	};

	return {
		confirmCreateWorktree,
		handleAddWorktree,
		handleCreateWorktreeFromBranch,
		setupNewWorktree,
	};
}
