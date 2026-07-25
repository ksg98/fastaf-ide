import { batch, type Setter } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { pathStartsWith } from "../../utils/pathUtils";

interface TerminalWorktreeCoordinatorDeps {
	refreshBranches: () => Promise<void>;
	setCurrentBranch: Setter<string | null>;
	setCurrentRepoPath: Setter<string | undefined>;
	writePty: (sessionId: string, data: string) => Promise<void>;
}

/** Owns OSC 7 CWD reassignment and explicit terminal-to-worktree moves. */
export function createTerminalWorktreeCoordinator(deps: TerminalWorktreeCoordinatorDeps) {
	const cwdDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Find the repo and branch whose worktree path is the longest CWD prefix. */
	const findBranchForCwd = (cwd: string): { repoPath: string; branchName: string } | null => {
		let best: { repoPath: string; branchName: string } | null = null;
		let bestLength = 0;
		for (const repoPath of repositoriesStore.getPaths()) {
			const repo = repositoriesStore.get(repoPath);
			if (!repo) continue;
			for (const [branchName, branch] of Object.entries(repo.branches)) {
				const worktreePath = branch.worktreePath ?? (branch.isMain ? repoPath : null);
				if (!worktreePath) continue;
				if (pathStartsWith(cwd, worktreePath) && worktreePath.length > bestLength) {
					best = { repoPath, branchName };
					bestLength = worktreePath.length;
				}
			}
		}
		return best;
	};

	const performCwdReassignment = async (terminalId: string, newCwd: string) => {
		if (!terminalsStore.get(terminalId)) return;

		const currentRepoPath = repositoriesStore.getRepoPathForTerminal(terminalId);
		let currentBranchName: string | null = null;
		if (currentRepoPath) {
			const repo = repositoriesStore.get(currentRepoPath);
			if (repo) {
				for (const [branchName, branch] of Object.entries(repo.branches)) {
					if (branch.terminals.includes(terminalId)) {
						currentBranchName = branchName;
						break;
					}
				}
			}
		}

		let target = findBranchForCwd(newCwd);
		if (!target && currentRepoPath) {
			const insideKnownRepo = repositoriesStore.getPaths().some((repoPath) => pathStartsWith(newCwd, repoPath));
			if (insideKnownRepo) {
				await deps.refreshBranches();
				target = findBranchForCwd(newCwd);
			}
		}

		if (!target) return;
		if (target.repoPath === currentRepoPath && target.branchName === currentBranchName) return;

		appLogger.info("terminal", `[CwdChange] ${terminalId} → ${target.repoPath}:${target.branchName} (cwd=${newCwd})`);
		batch(() => {
			if (currentRepoPath && currentBranchName) {
				repositoriesStore.removeTerminalFromBranch(currentRepoPath, currentBranchName, terminalId);
			}
			repositoriesStore.addTerminalToBranch(target.repoPath, target.branchName, terminalId);

			if (terminalsStore.state.activeId === terminalId) {
				repositoriesStore.setActiveBranch(target.repoPath, target.branchName);
				deps.setCurrentBranch(target.branchName);
				if (target.repoPath !== currentRepoPath) {
					repositoriesStore.setActive(target.repoPath);
					deps.setCurrentRepoPath(target.repoPath);
				}
			}
		});
	};

	const handleTerminalCwdChange = (terminalId: string, newCwd: string) => {
		clearTimeout(cwdDebounceTimers.get(terminalId));
		cwdDebounceTimers.set(
			terminalId,
			setTimeout(() => {
				cwdDebounceTimers.delete(terminalId);
				void performCwdReassignment(terminalId, newCwd).catch((error) =>
					appLogger.warn("terminal", `[CwdChange] reassignment error for ${terminalId}`, error),
				);
			}, 300),
		);
	};

	const cancelCwdTracking = (terminalId: string) => {
		const timer = cwdDebounceTimers.get(terminalId);
		if (timer !== undefined) {
			clearTimeout(timer);
			cwdDebounceTimers.delete(terminalId);
		}
	};

	const getWorktreeTargets = (terminalId: string): Array<{ branchName: string; path: string }> => {
		const repoPath = repositoriesStore.getRepoPathForTerminal(terminalId);
		if (!repoPath) return [];
		const repo = repositoriesStore.get(repoPath);
		if (!repo) return [];

		let currentBranchName: string | null = null;
		for (const [branchName, branch] of Object.entries(repo.branches)) {
			if (branch.terminals.includes(terminalId)) {
				currentBranchName = branchName;
				break;
			}
		}

		const targets: Array<{ branchName: string; path: string }> = [];
		for (const [branchName, branch] of Object.entries(repo.branches)) {
			if (branchName === currentBranchName) continue;
			const worktreePath = branch.worktreePath ?? (branch.isMain ? repoPath : null);
			if (worktreePath) targets.push({ branchName, path: worktreePath });
		}
		return targets;
	};

	const moveTerminalToWorktree = async (terminalId: string, worktreePath: string): Promise<void> => {
		const terminal = terminalsStore.get(terminalId);
		if (!terminal?.sessionId) return;
		const escapedPath = `'${worktreePath.replace(/'/g, "'\\''")}'`;
		await deps.writePty(terminal.sessionId, `cd ${escapedPath}\n`);
		appLogger.info("terminal", `[MoveToWorktree] ${terminalId} → cd ${worktreePath}`);
	};

	return { cancelCwdTracking, findBranchForCwd, getWorktreeTargets, handleTerminalCwdChange, moveTerminalToWorktree };
}
