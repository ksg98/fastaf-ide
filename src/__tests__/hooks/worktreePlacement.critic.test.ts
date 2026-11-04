import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { listen } from "@tauri-apps/api/event";
import { createBranchSelectionCoordinator } from "../../hooks/git/createBranchSelectionCoordinator";
import { useWorktreeSwitchPrompt } from "../../hooks/useWorktreeSwitchPrompt";
import { activityStore } from "../../stores/activityStore";
import { paneLayoutStore } from "../../stores/paneLayout";
import { repositoriesStore } from "../../stores/repositories";
import { reconcileTerminalOwnership } from "../../stores/terminalOwnership";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal, testInScopeAsync } from "../helpers/store";
import { mockInvoke } from "../mocks/tauri";

const REPO = "/Gits/critic-placement";
const WORKTREE = "/Gits/critic-placement__wt/feature";

describe("worktree placement lifecycle regressions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		paneLayoutStore.reset();
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		repositoriesStore._testSetHydrated(true);
		repositoriesStore.add({ path: REPO, displayName: "critic-placement" });
		repositoriesStore.setWorkspace(REPO, "main", { worktreePath: REPO });
		repositoriesStore.setWorkspace(REPO, "feature", { worktreePath: WORKTREE });
		repositoriesStore.setActiveWorkspace(REPO, "main");
	});

	afterEach(() => {
		paneLayoutStore._testCancelPendingSave();
		repositoriesStore._testCancelPendingSave();
		activityStore._testCancelPendingSave();
		terminalsStore._testCancelPendingTimers();
	});

	// Catches: creation and reconciliation move a root coordinator into a checkout it never entered.
	it("keeps a repo-root worktree creator in its actual cwd workspace", async () => {
		await testInScopeAsync(async () => {
			const id = terminalsStore.add(makeTerminal({ sessionId: "creator-pty", cwd: REPO, agentType: "codex" }));
			terminalsStore.setRepoPath(id, REPO);
			repositoriesStore.addTerminalToWorkspace(REPO, "main", id);
			const handlers = new Map<string, (event: { payload: unknown }) => void>();
			vi.mocked(listen).mockImplementation(async (name, handler) => {
				handlers.set(name, handler as (event: { payload: unknown }) => void);
				return () => {};
			});
			useWorktreeSwitchPrompt({ handleBranchSelect: async () => {}, closeTerminalsForBranch: async () => {} });
			handlers.get("worktree-created")?.({
				payload: {
					repo_path: REPO,
					workspace_id: "feature",
					branch: "feature",
					worktree_path: WORKTREE,
					kind: "worktree",
					creator_session: "creator-pty",
					spawn_session: false,
				},
			});
			expect(repositoriesStore.findOwnerForTerminal(id)?.workspaceId).toBe("main");
			reconcileTerminalOwnership();
			expect(repositoriesStore.findOwnerForTerminal(id)?.workspaceId).toBe("main");
			expect(terminalsStore.get(id)?.cwd).toBe(REPO);
		});
	});

	// Catches: cold restart undoes an explicit declaration because saved cwd stayed at root.
	it.each([true, false])("restores only a declaration matching the current checkout (valid=%s)", async (valid) => {
		await testInScopeAsync(async () => {
			const repo = repositoriesStore.get(REPO);
			if (!repo) throw new Error("fixture repository missing");
			repositoriesStore.setWorkspace(REPO, "feature", {
				savedTerminals: [
					{
						name: "Codex",
						cwd: REPO,
						fontSize: 14,
						agentType: "codex",
						agentSessionId: null,
						tuicSession: "stable-peer",
						agentLaunchCommand: null,
						suspended: true,
					},
				],
			});
			const persisted = JSON.parse(
				JSON.stringify({
					repos: {
						[REPO]: {
							...repo,
							declaredWorktrees: {
								"stable-peer": {
									workspaceId: "feature",
									branch: "feature",
									worktreePath: valid ? WORKTREE : "/removed-checkout",
								},
							},
						},
					},
					repoOrder: [REPO],
					activeRepoPath: REPO,
				}),
			);
			mockInvoke.mockImplementation(async (command) => (command === "load_repositories" ? persisted : undefined));
			await repositoriesStore.hydrate();
			const coordinator = createBranchSelectionCoordinator({
				repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
				pty: { canSpawn: async () => true },
				setStatusInfo: () => {},
				getDefaultFontSize: () => 14,
			});
			await coordinator.handleBranchSelectInner(REPO, "feature");
			// Let both scheduled focus frames finish before disposing the restored scope.
			await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			const id = terminalsStore.getIds().find((id) => terminalsStore.get(id)?.tuicSession === "stable-peer");
			if (!id) throw new Error("saved agent was not restored");
			expect(repositoriesStore.findOwnerForTerminal(id)?.workspaceId).toBe(valid ? "feature" : "main");
			reconcileTerminalOwnership();
			expect(repositoriesStore.findOwnerForTerminal(id)?.workspaceId).toBe(valid ? "feature" : "main");
			expect(terminalsStore.get(id)?.cwd).toBe(REPO);
			expect(repositoriesStore.getActive()?.activeWorkspaceId).toBe("feature");
			expect(repositoriesStore.getActive()?.workspaces.feature.terminals).toEqual(valid ? [id] : []);
			expect(terminalsStore.state.activeId).toBe(valid ? id : null);
		});
	});

	// Catches: filtering rehomed IDs shifts positional layout mappings or leaves foreign panes active.
	it.each([
		{ name: "mixed owners", cwds: [REPO, WORKTREE], hadTerminals: true, expectedCwd: WORKTREE, keepsLayout: false },
		{ name: "first-use workspace", cwds: [REPO], hadTerminals: false, expectedCwd: WORKTREE, keepsLayout: false },
		{
			name: "unchanged ownership",
			cwds: [WORKTREE, WORKTREE],
			hadTerminals: true,
			expectedCwd: WORKTREE,
			keepsLayout: true,
		},
	])(
		"keeps active tabs and disk panes in the selected workspace: $name",
		async ({ cwds, hadTerminals, expectedCwd, keepsLayout }) => {
			await testInScopeAsync(async () => {
				repositoriesStore.setWorkspace(REPO, "feature", {
					hadTerminals,
					savedTerminals: cwds.map((cwd, index) => ({
						name: `saved-${index}`,
						cwd,
						fontSize: 14,
						agentType: "codex",
						suspended: true,
					})),
				});
				const oldIds = cwds.map((_, index) => `old-${index}`);
				mockInvoke.mockImplementation(async (command) =>
					command === "load_pane_layout"
						? {
								root: { type: "leaf", id: "g1" },
								groups: {
									g1: { id: "g1", tabs: oldIds.map((id) => ({ id, type: "terminal" })), activeTabId: oldIds[0] },
								},
								activeGroupId: "g1",
							}
						: undefined,
				);
				await paneLayoutStore.loadFromDisk();
				await createBranchSelectionCoordinator({
					repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
					pty: { canSpawn: async () => true },
					setStatusInfo: () => {},
					getDefaultFontSize: () => 14,
				}).handleBranchSelectInner(REPO, "feature");
				await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				expect(repositoriesStore.getActive()?.activeWorkspaceId).toBe("feature");
				const visibleIds = repositoriesStore.getActive()?.workspaces.feature.terminals ?? [];
				expect(visibleIds).toContain(terminalsStore.state.activeId);
				expect(terminalsStore.getActive()?.cwd).toBe(expectedCwd);
				const paneIds = paneLayoutStore.getTerminalTabIds();
				if (keepsLayout) expect(paneIds).toEqual(visibleIds);
				else expect(paneIds).toEqual([]);
				for (const id of paneIds) expect(visibleIds).toContain(id);
				for (const id of terminalsStore.getIds()) {
					expect(repositoriesStore.findOwnerForTerminal(id)?.workspaceId).toBe(
						terminalsStore.get(id)?.cwd === REPO ? "main" : "feature",
					);
				}
			});
		},
	);
});
