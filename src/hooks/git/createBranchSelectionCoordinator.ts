import { batch, type Setter } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { globalWorkspaceStore } from "../../stores/globalWorkspace";
import { paneLayoutStore } from "../../stores/paneLayout";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { paneLayoutKey, savedPaneLayouts } from "../../stores/savedPaneLayouts";
import { terminalsStore } from "../../stores/terminals";
import { verifyAndBuildResumeCommand } from "../../utils/agentSession";
import { assignTabToActiveGroup } from "../../utils/paneTabAssign";
import { markPerf } from "../../utils/perfTrace";
import { filterValidTerminals } from "../../utils/terminalFilter";

interface BranchSelectionCoordinatorDeps {
	repo: {
		getDiffStats: (path: string) => Promise<{ additions: number; deletions: number }>;
	};
	pty: {
		canSpawn: () => Promise<boolean>;
	};
	setStatusInfo: (message: string) => void;
	getDefaultFontSize: () => number;
	setCurrentRepoPath: Setter<string | undefined>;
	setCurrentBranch: Setter<string | null>;
}

/** Owns terminal creation and serialized branch activation. */
export function createBranchSelectionCoordinator(deps: BranchSelectionCoordinatorDeps) {
	let branchSelectQueue: Promise<void> = Promise.resolve();

	const handleAddTerminalToBranch = async (repoPath: string, branchName: string) => {
		const canSpawn = await deps.pty.canSpawn();
		if (!canSpawn) {
			deps.setStatusInfo("Max sessions reached (50)");
			return;
		}

		// Ensure this repo+branch is active without going through handleBranchSelect
		// (which has auto-spawn logic that would create a duplicate terminal).
		// Batch all store writes to flush the reactive graph once instead of 6+ times.
		const activeRepo = repositoriesStore.getActive();
		const needsSwitch = activeRepo?.path !== repoPath || activeRepo?.activeBranch !== branchName;

		const branch = repositoriesStore.get(repoPath)?.branches[branchName];
		const termCount = branch?.terminals.length || 0;

		const label = repoSettingsStore.getEffective(repoPath)?.branchLabels?.[branchName];
		const tabName = label ?? `${branchName.split(/[\\/]/).pop()} ${termCount + 1}`;
		const id = terminalsStore.add({
			sessionId: null,
			fontSize: deps.getDefaultFontSize(),
			name: tabName,
			cwd: branch?.worktreePath || null,
			awaitingInput: null,
			tuicSession: crypto.randomUUID(),
		});
		if (label) terminalsStore.update(id, { nameIsCustom: true });

		batch(() => {
			if (needsSwitch) {
				repositoriesStore.setActive(repoPath);
				repositoriesStore.setActiveBranch(repoPath, branchName);
				deps.setCurrentRepoPath(repoPath);
				deps.setCurrentBranch(branchName);
			}
			// The owner of record, not just the display index. This path is handed the
			// repo, so leaving the field null would file a deliberate placement as the
			// "no registered repo claims this cwd" guess reconcileTerminalOwnership
			// is entitled to overturn.
			terminalsStore.setRepoPath(id, repoPath);
			repositoriesStore.addTerminalToBranch(repoPath, branchName, id);
			terminalsStore.setActive(id);
			if (!needsSwitch) {
				assignTabToActiveGroup(id, "terminal");
			}
		});
		// Focus the new terminal after SolidJS renders and mounts the component
		// (onMount sets ref, which happens in the next frame).
		requestAnimationFrame(() => terminalsStore.get(id)?.ref?.focus());
		return id;
	};

	const handleBranchSelect = (repoPath: string, branchName: string): Promise<void> => {
		// Append to the FIFO queue: this select runs only after every previously
		// queued select has settled. Each caller awaits the returned promise and sees
		// its own result/rejection; the queue tail swallows rejections so one failed
		// select doesn't break serialization for the calls behind it.
		const run = branchSelectQueue.then(() => handleBranchSelectInner(repoPath, branchName));
		branchSelectQueue = run.then(
			() => {},
			() => {},
		);
		return run;
	};

	const handleBranchSelectInner = async (repoPath: string, branchName: string) => {
		// Freeze-investigation: repo/branch switch is the reported foreground-freeze
		// trigger. Breadcrumb so a main-thread block during the switch cascade
		// attributes here (the freeze detector reports the freshest crumb).
		markPerf("branch.select", { repoPath, branchName });
		// Auto-deactivate global workspace before branch switch
		if (globalWorkspaceStore.isActive()) {
			const prevRepoPath = repositoriesStore.state.activeRepoPath;
			const prevBranch = prevRepoPath ? repositoriesStore.state.repositories[prevRepoPath]?.activeBranch : null;
			const key = prevRepoPath && prevBranch ? paneLayoutKey(prevRepoPath, prevBranch) : undefined;
			globalWorkspaceStore.deactivate(key);
		}

		repositoriesStore.setBranchSwitching(true);
		try {
			// Log the state we're LEAVING — critical for diagnosing terminal disappearance
			const prevRepo = repositoriesStore.getActive();
			const prevBranchName = prevRepo?.activeBranch;
			const prevBranch = prevBranchName ? prevRepo?.branches[prevBranchName] : null;
			appLogger.debug(
				"terminal",
				`BranchSelect ${prevBranchName ?? "(none)"} → ${branchName} terms=${(prevBranch?.terminals ?? []).length}→?`,
			);

			// Save state for the branch we're leaving
			if (prevRepo?.activeBranch) {
				const currentActiveId = terminalsStore.state.activeId;
				if (currentActiveId && prevBranch?.terminals.includes(currentActiveId)) {
					repositoriesStore.setBranch(prevRepo.path, prevRepo.activeBranch, { lastActiveTerminal: currentActiveId });
				}
				// Save pane layout for the branch we're leaving
				if (paneLayoutStore.isSplit()) {
					const key = paneLayoutKey(prevRepo.path, prevRepo.activeBranch);
					savedPaneLayouts.set(key, paneLayoutStore.serialize());
				} else {
					// Clear any stale layout if user unsplit while on this branch
					savedPaneLayouts.delete(paneLayoutKey(prevRepo.path, prevRepo.activeBranch));
				}
			}

			// Batch all reactive updates so downstream effects (file browser, etc.)
			// see a consistent snapshot — prevents stale intermediate states where
			// repoPath updated but fsRoot still points to the old worktree.
			batch(() => {
				deps.setCurrentRepoPath(repoPath);
				repositoriesStore.setActive(repoPath);
				repositoriesStore.setActiveBranch(repoPath, branchName);
				deps.setCurrentBranch(branchName);
			});

			// Fire-and-forget: diff stats are cosmetic, don't block branch switch
			const selectedBranch = repositoriesStore.get(repoPath)?.branches[branchName];
			if (selectedBranch?.worktreePath) {
				const wtPath = selectedBranch.worktreePath;
				deps.repo
					.getDiffStats(wtPath)
					.then((stats) => {
						repositoriesStore.updateBranchStats(repoPath, branchName, stats.additions, stats.deletions);
					})
					.catch((err) => appLogger.debug("git", `getDiffStats failed for ${branchName}`, err));
			}
			let branch = repositoriesStore.get(repoPath)?.branches[branchName];

			// Adopt orphaned terminals whose cwd matches this branch's worktree path.
			// Pre-compute claimed set O(B×T) once, then check in O(1) per terminal.
			if (branch?.worktreePath) {
				const branchTermSet = new Set(branch.terminals);
				const claimedIds = new Set<string>();
				for (const b of Object.values(repositoriesStore.get(repoPath)?.branches ?? {})) {
					if (b.name !== branchName) {
						for (const tid of b.terminals) claimedIds.add(tid);
					}
				}
				for (const id of terminalsStore.getIds()) {
					if (branchTermSet.has(id)) continue;
					if (claimedIds.has(id)) continue;
					const term = terminalsStore.get(id);
					if (term?.cwd === branch.worktreePath) {
						repositoriesStore.addTerminalToBranch(repoPath, branchName, id);
					}
				}
				// Re-read branch state after potential adoptions
				branch = repositoriesStore.get(repoPath)?.branches[branchName];
			}
			const validTerminals = filterValidTerminals(branch?.terminals, terminalsStore.getIds()).filter(
				(id) => !terminalsStore.isDetached(id),
			);
			appLogger.debug(
				"terminal",
				`BranchSelect → ${branchName} valid=${validTerminals.length} saved=${branch?.savedTerminals?.length ?? 0}`,
			);
			if (validTerminals.length === 0 && (branch?.terminals?.length ?? 0) > 0) {
				appLogger.warn(
					"terminal",
					`BranchSelect MISMATCH: branch has terminals ${JSON.stringify(branch?.terminals)} but none found in store ${JSON.stringify(terminalsStore.getIds())}. Will create fresh terminal.`,
				);
			}

			if (validTerminals.length > 0) {
				// Restore saved pane layout if available and all its terminals are still valid
				const layoutKey = paneLayoutKey(repoPath, branchName);
				const savedLayout = savedPaneLayouts.get(layoutKey);
				if (savedLayout) {
					const validSet = new Set(validTerminals);
					const layoutTerminals = Object.values(savedLayout.groups).flatMap((g) =>
						g.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
					);
					const allValid = layoutTerminals.length > 0 && layoutTerminals.every((id) => validSet.has(id));
					if (allValid) {
						paneLayoutStore.restore(savedLayout);
					} else {
						savedPaneLayouts.delete(layoutKey);
						paneLayoutStore.reset();
					}
				} else if (paneLayoutStore.consumeRestoredFromDisk()) {
					// Layout was loaded from disk at startup — keep it if terminal IDs are still valid
					const currentLayout = paneLayoutStore.serialize();
					const validSet = new Set(validTerminals);
					const layoutTerminals = Object.values(currentLayout.groups).flatMap((g) =>
						g.tabs.filter((t) => t.type === "terminal").map((t) => t.id),
					);
					if (!(layoutTerminals.length > 0 && layoutTerminals.every((id) => validSet.has(id)))) {
						paneLayoutStore.reset();
					}
				} else {
					paneLayoutStore.reset();
				}
				// Prefer a terminal that is awaiting input (question/error), then lastActive, then first
				const awaitingId = validTerminals.find((id) => terminalsStore.get(id)?.awaitingInput);
				if (awaitingId) {
					terminalsStore.setActive(awaitingId);
				} else {
					const remembered = branch?.lastActiveTerminal;
					if (remembered && validTerminals.includes(remembered)) {
						terminalsStore.setActive(remembered);
					} else {
						terminalsStore.setActive(validTerminals[0]);
					}
				}
			} else if (branch?.savedTerminals && branch.savedTerminals.length > 0) {
				// Only restore agent tabs with resumable sessions — plain shell tabs
				// have nothing meaningful to resume and would just be empty shells.
				const restorableTerminals = branch.savedTerminals.filter((t) => t.agentType != null);
				// Clear savedTerminals (consume-once) regardless of filter result
				repositoriesStore.setBranch(repoPath, branchName, { savedTerminals: [] });

				if (restorableTerminals.length > 0) {
					// Capture old terminal IDs from the pane layout (branch.terminals is cleared on hydration)
					const oldTerminalIds = paneLayoutStore.getTerminalTabIds();
					// Lazy restore: create terminals from persisted session state
					// First pass: create all terminals synchronously (instant UI)
					const restoredIds: { id: string; terminal: (typeof restorableTerminals)[number] }[] = [];
					for (const terminal of restorableTerminals) {
						const id = terminalsStore.add({
							sessionId: null,
							fontSize: terminal.fontSize,
							name: terminal.name,
							cwd: terminal.cwd,
							awaitingInput: null,
							tuicSession: terminal.tuicSession ?? crypto.randomUUID(),
							agentType: terminal.agentType ?? null,
							agentSessionId: terminal.agentSessionId ?? null,
							agentLaunchCommand: terminal.agentLaunchCommand ?? null,
						});
						// Same reason as handleAddTerminalToBranch: a restore knows its repo.
						terminalsStore.setRepoPath(id, repoPath);
						repositoriesStore.addTerminalToBranch(repoPath, branchName, id);
						restoredIds.push({ id, terminal });
					}
					if (restoredIds.length > 0) terminalsStore.setActive(restoredIds[0].id);

					// Remap disk-restored layout terminal IDs to newly created IDs
					const hasDiskLayout = paneLayoutStore.consumeRestoredFromDisk();
					if (hasDiskLayout && oldTerminalIds.length > 0) {
						const idMap = new Map<string, string>();
						for (let i = 0; i < Math.min(oldTerminalIds.length, restoredIds.length); i++) {
							idMap.set(oldTerminalIds[i], restoredIds[i].id);
						}
						paneLayoutStore.remapTerminalIds(idMap);
						appLogger.debug("terminal", `BranchSelect REMAP disk-restored paneLayout for ${branchName}`, {
							remapped: idMap.size,
						});
					} else {
						paneLayoutStore.reset();
					}

					// Second pass: verify resume commands in parallel (non-blocking)
					Promise.all(
						restoredIds.map(async ({ id, terminal }) => {
							const resumeCmd = await verifyAndBuildResumeCommand(
								terminal.agentType!,
								terminal.cwd,
								terminal.tuicSession,
								terminal.agentSessionId,
								terminal.agentLaunchCommand,
							);
							if (resumeCmd) {
								terminalsStore.update(id, {
									pendingResumeCommand: resumeCmd,
									agentSessionId: terminal.agentSessionId ?? null,
								});
							}
						}),
					).catch((e) => appLogger.warn("terminal", "Resume command verification failed", { error: String(e) }));
				} else {
					// All saved tabs were plain shells — spawn a fresh terminal
					paneLayoutStore.reset();
					await handleAddTerminalToBranch(repoPath, branchName);
				}
			} else if (!branch?.hadTerminals) {
				// First time selecting this branch — auto-spawn a terminal
				// DEFERRED (2026-07-31) — no existence check on branch.worktreePath: selecting
				// a row whose worktree directory is gone spawns a terminal in a missing cwd
				// ("Spawn failed (dir missing)" + a failed dir watcher), which is what kept
				// deleted worktrees looking alive in the sidebar. The row itself is now pruned
				// at the source (worktree-removed event + worktree set in the repo-watcher
				// fingerprint), so the only way to reach this is a row hydrated from disk
				// before the first refresh prunes it. Needs a backend path-exists round-trip
				// on every branch select — not worth it until that window is observed.
				paneLayoutStore.reset();
				await handleAddTerminalToBranch(repoPath, branchName);
			} else {
				// hadTerminals && no valid terminals → user closed them all, show empty state.
				// Clear layout and activeId so the previous branch's split doesn't bleed through.
				paneLayoutStore.reset();
				terminalsStore.setActive(null);
			}

			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					terminalsStore.getActive()?.ref?.focus();
				});
			});
		} finally {
			// Story 1281-a37d: always clear the flag, even on throw. Without this,
			// a rejected close_pty / getDiffStats / resume-verification left the
			// TabBar filtering on the previous repo until app restart.
			repositoriesStore.setBranchSwitching(false);
		}
	};

	return { handleAddTerminalToBranch, handleBranchSelect, handleBranchSelectInner };
}
