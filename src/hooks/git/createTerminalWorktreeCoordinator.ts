import { batch, type Setter } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { placementBranchFor, repositoriesStore, resolveRepoOwner } from "../../stores/repositories";
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

	/** Find the repo and branch that own a CWD.
	 *
	 *  A linked worktree names its branch. A match at the repo root does not — what
	 *  is checked out there changes under the user's feet — so the root resolves
	 *  through `activeBranch` at the moment we need it. */
	const findBranchForCwd = (cwd: string): { repoPath: string; branchName: string } | null => {
		const owner = resolveRepoOwner(cwd);
		if (!owner) return null;
		const branchName = placementBranchFor(owner);
		return branchName ? { repoPath: owner.repoPath, branchName } : null;
	};

	const performCwdReassignment = async (terminalId: string, newCwd: string) => {
		if (!terminalsStore.get(terminalId)) return;

		const currentRepoPath = repositoriesStore.getRepoPathForTerminal(terminalId);
		const currentBranchName = repositoriesStore.findOwnerForTerminal(terminalId)?.branchName ?? null;

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

		// A cd across repos is navigation, not a placement. The tab belongs to the repo
		// it was opened in — `repoPath` records that owner — and this path may only move
		// it *within* that repo, which is what a worktree switch is. Re-homing an owned
		// tab across repos is the regression Boss reported as "the app changes repo on
		// its own": the tab left the strip, and the branch below even switched the
		// sidebar to the other repo. A tab still parked (`repoPath === null`) has no
		// owner to respect, so a cd may still settle it.
		const owner = terminalsStore.get(terminalId)?.repoPath ?? null;
		if (owner !== null && target.repoPath !== owner) return;

		appLogger.info("terminal", `[CwdChange] ${terminalId} → ${target.repoPath}:${target.branchName} (cwd=${newCwd})`);
		batch(() => {
			if (currentRepoPath && currentBranchName) {
				repositoriesStore.removeTerminalFromBranch(currentRepoPath, currentBranchName, terminalId);
			}
			// The branch arrays are the display index; the terminal's own repoPath is
			// the record. Moving one without the other is what left ids stranded.
			terminalsStore.setRepoPath(terminalId, target.repoPath);
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

		const currentBranchName = repositoriesStore.findOwnerForTerminal(terminalId)?.branchName ?? null;

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
