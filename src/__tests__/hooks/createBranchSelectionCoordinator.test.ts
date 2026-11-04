import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

describe("createBranchSelectionCoordinator", () => {
	let createBranchSelectionCoordinator: typeof import("../../hooks/git/createBranchSelectionCoordinator").createBranchSelectionCoordinator;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		createBranchSelectionCoordinator = (await import("../../hooks/git/createBranchSelectionCoordinator"))
			.createBranchSelectionCoordinator;
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		repositoriesStore._testSetHydrated(true);
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
	});

	const makeCoordinator = () =>
		createBranchSelectionCoordinator({
			repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
			pty: { canSpawn: async () => true },
			setStatusInfo: () => {},
			getDefaultFontSize: () => 14,
		});

	// `TerminalData.repoPath` is the owning repo of record — the field
	// `reconcileTerminalOwnership` trusts over the branch arrays, where `null`
	// means "no registered repo claims this cwd, the placement is a guess". This
	// path is the opposite of a guess: it is handed the repo. Leaving the field
	// null here filed a deliberately placed terminal as parked.
	it("records the owning repo on a terminal it adds to a branch", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", { worktreePath: "/Gits/alpha" });
			repositoriesStore.setActiveWorkspace("/Gits/alpha", "main");

			const id = await makeCoordinator().handleAddTerminalToWorkspace("/Gits/alpha", "main");

			expect(id).toBeTruthy();
			expect(terminalsStore.get(id!)?.repoPath).toBe("/Gits/alpha");
			expect(repositoriesStore.findOwnerForTerminal(id!)).toEqual({
				repoPath: "/Gits/alpha",
				workspaceId: "main",
			});
		});
	});

	/**
	 * `cwd: null` is not "the default directory" — the backend spawns the PTY in the
	 * user's HOME. A workspace row whose `worktreePath` was never filled in (a row
	 * created by `setWorkspace` before the first refresh writes the path) therefore
	 * opened a terminal on `~` inside a repo tab. Seen live.
	 */
	it("spawns in the repo when the workspace carries no worktree path", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main");

			const id = await makeCoordinator().handleAddTerminalToWorkspace("/Gits/alpha", "main");

			expect(terminalsStore.get(id!)?.cwd).toBe("/Gits/alpha");
		});
	});

	it("keeps a linked worktree's own path as the cwd", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "feature", { worktreePath: "/Gits/alpha__wt/feature" });

			const id = await makeCoordinator().handleAddTerminalToWorkspace("/Gits/alpha", "feature");

			expect(terminalsStore.get(id!)?.cwd).toBe("/Gits/alpha__wt/feature");
		});
	});

	/** The id named a workspace that had been pruned: the terminal joined nothing,
	 *  so it rendered without a tab, and its cwd fell through to HOME. */
	it("still spawns in the repo when the workspace id names no row", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", { worktreePath: "/Gits/alpha" });

			const id = await makeCoordinator().handleAddTerminalToWorkspace("/Gits/alpha", "branch-that-was-pruned");

			expect(terminalsStore.get(id!)?.cwd).toBe("/Gits/alpha");
			// The row it was asked to join does not exist, so the pointer must not follow it.
			expect(repositoriesStore.get("/Gits/alpha")?.activeWorkspaceId).not.toBe("branch-that-was-pruned");
		});
	});

	/**
	 * The alias is an address other agents already hold. A restore that drops it
	 * hands the tab a fresh number, so "notify tu-3" reaches a different terminal
	 * — or nothing at all — after every restart.
	 */
	it("carries a saved alias onto the terminal it restores", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", {
				worktreePath: "/Gits/alpha",
				savedTerminals: [
					{
						name: "claude",
						cwd: "/Gits/alpha",
						fontSize: 14,
						agentType: "claude",
						agentSessionId: null,
						tuicSession: "tab-uuid",
						agentLaunchCommand: null,
						alias: "al-3",
					},
				],
			});

			await makeCoordinator().handleBranchSelectInner("/Gits/alpha", "main");

			const restored = terminalsStore.getIds().map((id) => terminalsStore.get(id));
			expect(restored.map((t) => t?.alias)).toEqual(["al-3"]);
			expect(restored.map((t) => t?.tuicSession)).toEqual(["tab-uuid"]);
		});
	});

	/**
	 * A restored tab used to say only "Agent session was active" — the user had to
	 * resume it to find out what it was. The snapshot carries the last intent and
	 * prompt so the banner can name the work before the click.
	 */
	it("carries the saved intent and prompt onto the terminal it restores", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", {
				worktreePath: "/Gits/alpha",
				savedTerminals: [
					{
						name: "claude",
						cwd: "/Gits/alpha",
						fontSize: 14,
						agentType: "claude",
						agentSessionId: null,
						tuicSession: "tab-uuid",
						agentLaunchCommand: null,
						alias: null,
						agentIntent: "finishing the resume banner",
						lastPrompt: "show the intent on the recovery banner",
					},
				],
			});

			await makeCoordinator().handleBranchSelectInner("/Gits/alpha", "main");

			const restored = terminalsStore.getIds().map((id) => terminalsStore.get(id));
			expect(restored.map((t) => t?.agentIntent)).toEqual(["finishing the resume banner"]);
			expect(restored.map((t) => t?.lastPrompt)).toEqual(["show the intent on the recovery banner"]);
		});
	});

	it("does not create a terminal when the spawn budget is exhausted", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", { worktreePath: "/Gits/alpha" });

			const messages: string[] = [];
			const coordinator = createBranchSelectionCoordinator({
				repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
				pty: { canSpawn: async () => false },
				setStatusInfo: (message) => messages.push(message),
				getDefaultFontSize: () => 14,
			});

			expect(await coordinator.handleAddTerminalToWorkspace("/Gits/alpha", "main")).toBeUndefined();
			expect(terminalsStore.getIds()).toHaveLength(0);
			expect(messages).toEqual(["Max sessions reached (50)"]);
		});
	});
});
