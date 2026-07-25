import { batch, type Setter } from "solid-js";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { repoSettingsStore } from "../../stores/repoSettings";
import { type RepositoryState, repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { timeBatch } from "../../utils/perfTrace";
import type { AgentSeed } from "./agentSeed";

export interface PendingCreation {
	repoPath: string;
	displayName: string;
	result: { name: string; path: string; branch: string; base_repo: string };
	agentSeed?: AgentSeed;
}

interface RepositoryRefreshCoordinatorDeps {
	repo: {
		getInfo: (path: string) => Promise<{ branch: string; is_git_repo: boolean }>;
		getRepoStructure: (repoPath: string) => Promise<{
			worktree_paths: Record<string, string>;
			merged_branches: string[];
		}>;
		getRepoDiffStats: (repoPath: string) => Promise<{
			diff_stats: Record<string, { additions: number; deletions: number }>;
			last_commit_ts: Record<string, number | null>;
		}>;
		detectOrphanWorktrees: (repoPath: string) => Promise<string[]>;
		removeOrphanWorktree: (repoPath: string, worktreePath: string) => Promise<void>;
		finalizeMergedWorktree: (
			repoPath: string,
			branchName: string,
			action: "archive" | "delete",
		) => Promise<{ merged: boolean; action: string; archive_path: string | null }>;
	};
	dialogs: {
		confirmOrphanCleanup?: (paths: string[]) => Promise<boolean>;
	};
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>;
	closeTerminalsInWorktree: (worktreePath: string) => Promise<void>;
	setupNewWorktree: (
		repoPath: string,
		result: PendingCreation["result"],
		displayName: string,
		agentSeed?: AgentSeed,
	) => Promise<void>;
	setCreatingWorktreeRepos: Setter<Set<string>>;
	setStatusInfo: (message: string) => void;
	pendingCreations: Map<string, PendingCreation>;
	pendingKey: (repoPath: string, branchName: string) => string;
}

/** Owns two-phase repository refresh, stale-write guards, cleanup, and creation grace. */
export function createRepositoryRefreshCoordinator(deps: RepositoryRefreshCoordinatorDeps) {
	const { pendingCreations, pendingKey } = deps;

	/** Transition a repo from git to shell mode (e.g. .git was removed) */
	const transitionToShell = (repoPath: string, currentRepo: RepositoryState) => {
		batch(() => {
			// Migrate all terminals to a shell branch
			const allTerminals: string[] = [];
			for (const branch of Object.values(currentRepo.branches)) {
				allTerminals.push(...branch.terminals);
				repositoriesStore.removeBranch(repoPath, branch.name);
			}
			repositoriesStore.setIsGitRepo(repoPath, false);
			const shellBranch = "shell";
			repositoriesStore.setBranch(repoPath, shellBranch, {
				worktreePath: repoPath,
				isMain: true,
				isShell: true,
			});
			for (const termId of allTerminals) {
				repositoriesStore.addTerminalToBranch(repoPath, shellBranch, termId);
			}
			repositoriesStore.setActiveBranch(repoPath, shellBranch);
		});
	};

	// Per-repo refresh generation counter — discards stale Phase 2 writes
	// when a newer refresh has started for the same repo.
	const refreshGeneration = new Map<string, number>();

	// Branch removals processed recently, keyed by `${repoPath}::${branchName}`.
	// FSEvents fires multiple repo-changed bursts when a worktree is deleted
	// (one for .git/worktrees/<name>, one for the worktree directory itself),
	// which can schedule overlapping refresh cycles. Without dedup, the same
	// terminals would be force-closed twice and the same branch removed twice,
	// racing store subscribers and causing visible UI thrash. Entries expire
	// after PROCESS_DEDUP_WINDOW_MS so a legitimate later re-creation is not
	// blocked indefinitely.
	const recentlyProcessedBranches = new Map<string, number>();
	const PROCESS_DEDUP_WINDOW_MS = 2000;

	// Grace period: branches just created via setupNewWorktree are protected from
	// refresh-triggered removal for CREATION_GRACE_WINDOW_MS. This guards against
	// the race where git hasn't fully registered the new worktree by the time the
	// first repo-changed refresh fires (idempotent dir-exists path, slow FS, etc.).
	const recentlyCreatedBranches = new Map<string, number>();
	// Bumped from 5s → 60s to cover the worst-case background stale-recovery
	// flow (large checkout, LFS, slow FS). 5s was shorter than the typical
	// recreate window, so the failure path silently removed the placeholder
	// before the grace expired.
	const CREATION_GRACE_WINDOW_MS = 60_000;
	const markRecentlyCreated = (repoPath: string, branchName: string): void => {
		const now = Date.now();
		for (const [k, ts] of recentlyCreatedBranches) {
			if (now - ts > CREATION_GRACE_WINDOW_MS) recentlyCreatedBranches.delete(k);
		}
		recentlyCreatedBranches.set(`${repoPath}::${branchName}`, now);
	};
	const isRecentlyCreated = (repoPath: string, branchName: string): boolean => {
		const key = `${repoPath}::${branchName}`;
		const ts = recentlyCreatedBranches.get(key);
		if (ts === undefined) return false;
		if (Date.now() - ts > CREATION_GRACE_WINDOW_MS) {
			recentlyCreatedBranches.delete(key);
			return false;
		}
		return true;
	};

	const alreadyProcessed = (repoPath: string, branchName: string): boolean => {
		const key = `${repoPath}::${branchName}`;
		const ts = recentlyProcessedBranches.get(key);
		if (ts === undefined) return false;
		if (Date.now() - ts > PROCESS_DEDUP_WINDOW_MS) {
			recentlyProcessedBranches.delete(key);
			return false;
		}
		return true;
	};
	const markProcessed = (repoPath: string, branchName: string): void => {
		const now = Date.now();
		// Sweep expired entries on every write so the map stays bounded by the
		// number of branches removed within PROCESS_DEDUP_WINDOW_MS — without
		// this, branches removed and never re-queried leak forever.
		for (const [k, ts] of recentlyProcessedBranches) {
			if (now - ts > PROCESS_DEDUP_WINDOW_MS) recentlyProcessedBranches.delete(k);
		}
		recentlyProcessedBranches.set(`${repoPath}::${branchName}`, now);
	};

	// `scopeRepoPath` limits the refresh to a single repo. A `repo-changed`
	// event carries the one repo that changed, so scoping avoids re-scanning
	// every open repo in unison on each filesystem event. Called with no arg
	// (init, branch ops) it refreshes all active repos as before.
	const refreshAllBranchStats = async (scopeRepoPath?: string) => {
		// Skip parked repos — they should stay dormant. (#1358-caf5)
		const activePaths = repositoriesStore.getActivePaths();
		const paths = scopeRepoPath ? activePaths.filter((p) => p === scopeRepoPath) : activePaths;
		await Promise.all(
			paths.map(async (repoPath) => {
				const gen = (refreshGeneration.get(repoPath) ?? 0) + 1;
				refreshGeneration.set(repoPath, gen);

				const repo = repositoriesStore.get(repoPath);
				if (!repo) return;
				// Snapshot branch keys before any await so we can detect user-triggered
				// removals that happen while async ops are in-flight (race condition guard).
				const priorBranchKeys = new Set(Object.keys(repo.branches));
				// Non-git directories: check if they became a git repo
				if (repo.isGitRepo === false) {
					try {
						const info = await deps.repo.getInfo(repoPath);
						if (info.is_git_repo && info.branch) {
							// Directory gained .git — transition to git mode. Carry the shell
							// branch's terminals (and its last-active) into the new git branch:
							// otherwise `git init` removes the shell branch and creates an empty
							// git branch, orphaning the open terminals so they vanish from the
							// view until a later branch-select re-adopts them by cwd.
							batch(() => {
								const carriedTerminals: string[] = [];
								let carriedActive: string | null = null;
								for (const branch of Object.values(repo.branches)) {
									carriedTerminals.push(...branch.terminals);
									if (branch.lastActiveTerminal) carriedActive = branch.lastActiveTerminal;
									repositoriesStore.removeBranch(repoPath, branch.name);
								}
								repositoriesStore.setIsGitRepo(repoPath, true);
								repositoriesStore.setBranch(repoPath, info.branch, {
									worktreePath: repoPath,
									lastActiveTerminal: carriedActive,
								});
								// addTerminalToBranch (not setBranch terminals) keeps the
								// terminalToRepo inverse index consistent.
								for (const tid of carriedTerminals) {
									repositoriesStore.addTerminalToBranch(repoPath, info.branch, tid);
								}
								repositoriesStore.setActiveBranch(repoPath, info.branch);
							});
							// Restart the repo watcher so it registers the now-present .git
							// sub-watches (HEAD/refs/worktrees). On macOS/Windows the recursive
							// root watch already covers .git, but Linux uses targeted watches
							// that were skipped while the directory was non-git.
							invoke("stop_repo_watcher", { repoPath })
								.then(() => invoke("start_repo_watcher", { repoPath }))
								.catch((e) =>
									appLogger.debug("git", "Watcher restart after git-init failed", { repoPath, error: String(e) }),
								);
						}
					} catch (e) {
						appLogger.debug("git", "Repo probe failed — staying in shell mode", { repoPath, error: String(e) });
					}
					return;
				}

				// === PHASE 1: Structure (fast) ===
				// Returns worktree_paths + merged_branches only — no expensive diff stats.
				const structure = await deps.repo.getRepoStructure(repoPath);
				if (refreshGeneration.get(repoPath) !== gen) return; // stale

				const worktreePaths = structure.worktree_paths;
				const mergedSet = new Set(structure.merged_branches);

				const currentRepo = repositoriesStore.get(repoPath);
				if (!currentRepo) return;

				if (Object.keys(worktreePaths).length === 0) {
					// Worktrees came back empty — either a transient backend error or the
					// repo is no longer a git repo. Probe to find out.
					try {
						const info = await deps.repo.getInfo(repoPath);
						if (!info.is_git_repo) {
							transitionToShell(repoPath, currentRepo);
							return;
						}
					} catch (e) {
						appLogger.debug("git", "getInfo failed — preserving UI state", { repoPath, error: String(e) });
					}
					// Still a git repo but no worktrees returned — skip to avoid
					// destroying existing branch state on a transient error.
					if (Object.keys(currentRepo.branches).length > 0) return;
				}

				// Compute the target set of branches to keep, then apply all
				// mutations in a single batch to prevent intermediate renders
				// (which caused the sidebar to flash/jump during refresh).
				const storeIds = new Set(terminalsStore.getIds());
				const toRemove: string[] = [];
				const terminalsToClose: string[] = [];

				// If activeBranch is no longer a worktree, find its replacement:
				// the worktree branch that occupies the same path (HEAD moved).
				let activeBranchReplacement: string | null = null;
				const active = currentRepo.activeBranch;
				if (active && !(active in worktreePaths)) {
					const activePath = currentRepo.branches[active]?.worktreePath;
					if (activePath) {
						for (const [wtBranch, wtPath] of Object.entries(worktreePaths)) {
							if (wtPath === activePath) {
								activeBranchReplacement = wtBranch;
								break;
							}
						}
					}
				}

				for (const branchName of Object.keys(currentRepo.branches)) {
					if (!(branchName in worktreePaths)) {
						// Skip branches that a concurrent/recent refresh already handled.
						// The store removal may not have settled yet (batch scheduled), so
						// we'd otherwise re-enqueue the same close+remove.
						if (alreadyProcessed(repoPath, branchName)) continue;
						// Skip branches just created — git may not have fully registered the
						// worktree by the time the first repo-changed refresh fires.
						if (isRecentlyCreated(repoPath, branchName)) {
							appLogger.info("git", `refreshAllBranchStats: CREATION GRACE skipping "${branchName}" (just created)`, {
								repoPath,
							});
							continue;
						}
						// If this is the stale activeBranch and we found a replacement, allow removal
						if (branchName === active && activeBranchReplacement) {
							appLogger.info(
								"terminal",
								`refreshAllBranchStats: activeBranch "${branchName}" replaced by "${activeBranchReplacement}"`,
							);
							toRemove.push(branchName);
							markProcessed(repoPath, branchName);
							continue;
						}
						// Branch has live terminals — only keep it if the worktree path
						// is the main repo checkout (HEAD switched away). If the worktree
						// directory was deleted externally, close the orphaned terminals
						// so the stale branch can be cleaned up.
						const branchState = currentRepo.branches[branchName];
						const hasLiveTerminals = branchState?.terminals.some((id) => storeIds.has(id));
						if (hasLiveTerminals) {
							const isLinkedWorktree = branchState.worktreePath && branchState.worktreePath !== repoPath;
							if (isLinkedWorktree) {
								// Linked worktree was removed externally — close its terminals
								appLogger.info(
									"terminal",
									`refreshAllBranchStats: closing terminals for deleted worktree "${branchName}"`,
									{
										terminals: branchState.terminals,
										worktreePath: branchState.worktreePath,
									},
								);
								terminalsToClose.push(...branchState.terminals.filter((id) => storeIds.has(id)));
								toRemove.push(branchName);
								markProcessed(repoPath, branchName);
							} else {
								appLogger.info("terminal", `refreshAllBranchStats: keeping "${branchName}" — has live terminals`, {
									terminals: branchState.terminals,
								});
							}
							continue;
						}
						toRemove.push(branchName);
						markProcessed(repoPath, branchName);
					}
				}

				if (toRemove.length > 0) {
					appLogger.info("terminal", `refreshAllBranchStats removing branches from ${repoPath}`, {
						toRemove,
						worktreePathKeys: Object.keys(worktreePaths),
						existingBranches: Object.keys(currentRepo.branches),
					});
				}

				// Close terminals for deleted worktrees before mutating store state.
				// Best-effort: a PTY may already be dead; log and continue so the
				// branch removal in the batch below is not blocked.
				await Promise.allSettled(
					terminalsToClose.map(async (termId) => {
						try {
							await deps.closeTerminal(termId, true);
						} catch (err) {
							appLogger.warn("terminal", `refreshAllBranchStats: failed to close terminal ${termId}`, err);
						}
					}),
				);

				const drainedPendings: PendingCreation[] = [];
				// Freeze-investigation: split the structural batch into body (our
				// setState loop) vs reactive flush (dependent effects/memos waking).
				timeBatch(`git.refreshBatch:${repoPath}`, (markBodyEnd) =>
					batch(() => {
						// Guard against race: if a branch was present before our async ops
						// but is now gone from the live store, the user deleted it while we
						// were in-flight. Don't resurrect it via stale worktreePaths data.
						const liveRepo = repositoriesStore.get(repoPath);
						// Create new worktree branches first so mergeBranchState has a target
						for (const [branchName, wtPath] of Object.entries(worktreePaths)) {
							if (priorBranchKeys.has(branchName) && !liveRepo?.branches[branchName]) {
								appLogger.info("git", `refreshAllBranchStats: RACE GUARD blocked resurrection of "${branchName}"`, {
									repoPath,
									worktreePath: wtPath,
								});
								continue;
							}
							const update: Partial<import("../../stores/repositories").BranchState> = {
								worktreePath: wtPath,
								isMerged: mergedSet.has(branchName),
							};
							// Branch finished background preparation — clear placeholder state
							// and queue the deferred setupNewWorktree (setup script, initial
							// terminal, runScript) for after the batch commits.
							if (liveRepo?.branches[branchName]?.isPreparing) {
								update.isPreparing = false;
								const k = pendingKey(repoPath, branchName);
								const pend = pendingCreations.get(k);
								if (pend) {
									pendingCreations.delete(k);
									drainedPendings.push(pend);
								}
							}
							repositoriesStore.setBranch(repoPath, branchName, update);
						}
						// Migrate terminal state from stale activeBranch to its replacement
						if (active && activeBranchReplacement && toRemove.includes(active)) {
							repositoriesStore.mergeBranchState(repoPath, active, activeBranchReplacement);
							repositoriesStore.setActiveBranch(repoPath, activeBranchReplacement);
						}
						for (const branchName of toRemove) {
							repositoriesStore.removeBranch(repoPath, branchName);
						}
						markBodyEnd();
					}),
				);

				// Drain pending creates: their backing worktree directory finally
				// exists, so it's safe to run the setup script + spawn the initial
				// terminal. Releases the per-repo creatingWorktreeRepos lock that
				// confirmCreateWorktree/handleCreateWorktreeFromBranch held open.
				for (const pend of drainedPendings) {
					try {
						await deps.setupNewWorktree(pend.repoPath, pend.result, pend.displayName, pend.agentSeed);
					} catch (err) {
						appLogger.error("git", `setupNewWorktree (pending drain) failed for ${pend.result.branch}`, err);
					}
					deps.setCreatingWorktreeRepos((prev) => {
						const next = new Set(prev);
						next.delete(pend.repoPath);
						return next;
					});
				}

				const updatedRepo = repositoriesStore.get(repoPath);
				if (!updatedRepo) return;

				// Side effects that only need structure data — run before Phase 2
				await handleAutoArchiveMerged(repoPath, updatedRepo.branches);
				await handleOrphanCleanup(repoPath);

				// === PHASE 2: Stats (slow) ===
				// Per-worktree diff stats + last-commit timestamps.
				// Non-fatal: if this fails, UI shows rows from Phase 1 with stale/zero stats.
				if (refreshGeneration.get(repoPath) !== gen) return; // stale check before Phase 2

				try {
					const stats = await deps.repo.getRepoDiffStats(repoPath);
					if (refreshGeneration.get(repoPath) !== gen) return; // stale after await

					const currentRepoForStats = repositoriesStore.get(repoPath);
					if (!currentRepoForStats) return;

					// Freeze-investigation: same body-vs-flush split for the stats batch.
					timeBatch(`git.statsBatch:${repoPath}`, (markBodyEnd) =>
						batch(() => {
							for (const branch of Object.values(currentRepoForStats.branches)) {
								if (!branch.worktreePath) continue;
								const ds = stats.diff_stats[branch.worktreePath];
								if (ds) {
									repositoriesStore.updateBranchStats(repoPath, branch.name, ds.additions, ds.deletions);
								}
								const ts = stats.last_commit_ts?.[branch.name];
								if (ts !== undefined) {
									// Rust emits Unix seconds (%ct); JS Date.now() uses milliseconds
									repositoriesStore.setBranch(repoPath, branch.name, {
										lastCommitTs: ts !== null ? ts * 1000 : null,
									});
								}
							}
							markBodyEnd();
						}),
					);
				} catch (err) {
					appLogger.warn("git", `Phase 2 diff stats failed for ${repoPath}`, err);
				}
			}),
		);
	};

	/** Detect orphaned linked worktrees and act based on the orphanCleanup setting. */
	let orphanDialogOpen = false;
	// Orphans the user chose to "Keep" this session — don't nag about them again
	// on every subsequent refresh/poll. Session-scoped (re-detected on next launch). (#65)
	const keptOrphans = new Set<string>();
	const handleOrphanCleanup = async (repoPath: string) => {
		const orphanCleanup = repoSettingsStore.getEffective(repoPath)?.orphanCleanup ?? "ask";
		if (orphanCleanup === "off") return;

		let orphanPaths: string[];
		try {
			orphanPaths = await deps.repo.detectOrphanWorktrees(repoPath);
		} catch {
			return; // Detection failure is non-fatal
		}
		if (orphanPaths.length === 0) return;

		if (orphanCleanup === "on") {
			// Auto-remove silently
			await Promise.allSettled(
				orphanPaths.map(async (wtPath) => {
					try {
						await deps.closeTerminalsInWorktree(wtPath);
						await deps.repo.removeOrphanWorktree(repoPath, wtPath);
					} catch (err) {
						appLogger.warn("git", `Failed to auto-remove orphan worktree ${wtPath}`, err);
					}
				}),
			);
			deps.setStatusInfo(`Removed ${orphanPaths.length} orphaned worktree(s)`);
			return;
		}

		// orphanCleanup === "ask"
		// Skip orphans the user already chose to keep — otherwise the dialog re-fires
		// on every refresh until the underlying worktree state changes. (#65)
		const pending = orphanPaths.filter((p) => !keptOrphans.has(p));
		if (pending.length === 0) return;

		if (orphanDialogOpen) return; // Prevent duplicate dialogs from concurrent refreshes
		orphanDialogOpen = true;
		let confirmed: boolean;
		try {
			confirmed = (await deps.dialogs.confirmOrphanCleanup?.(pending)) ?? false;
		} finally {
			orphanDialogOpen = false;
		}
		if (!confirmed) {
			// User chose "Keep" — remember these so we don't prompt again this session.
			for (const p of pending) keptOrphans.add(p);
			return;
		}

		await Promise.allSettled(
			pending.map(async (wtPath) => {
				try {
					await deps.closeTerminalsInWorktree(wtPath);
					await deps.repo.removeOrphanWorktree(repoPath, wtPath);
				} catch (err) {
					appLogger.warn("git", `Failed to remove orphan worktree ${wtPath}`, err);
				}
			}),
		);
		deps.setStatusInfo(`Removed ${pending.length} orphaned worktree(s)`);
	};

	/** Archive all merged linked worktrees when the autoArchiveMerged setting is enabled. */
	const handleAutoArchiveMerged = async (repoPath: string, branches: RepositoryState["branches"]) => {
		if (!repoSettingsStore.getEffective(repoPath)?.autoArchiveMerged) return;

		const mergedLinkedBranches = Object.values(branches).filter(
			(b) => b.isMerged && b.worktreePath !== null && b.worktreePath !== repoPath,
		);
		if (mergedLinkedBranches.length === 0) return;

		let archived = 0;
		const results = await Promise.allSettled(
			mergedLinkedBranches.map((branch) => deps.repo.finalizeMergedWorktree(repoPath, branch.name, "archive")),
		);
		results.forEach((result, i) => {
			if (result.status === "fulfilled") {
				archived++;
			} else {
				appLogger.warn(
					"git",
					`Failed to auto-archive merged worktree for "${mergedLinkedBranches[i].name}"`,
					result.reason,
				);
			}
		});
		if (archived > 0) {
			deps.setStatusInfo(`Auto-archived ${archived} merged worktree(s)`);
		}
	};

	return { markRecentlyCreated, refreshAllBranchStats };
}
