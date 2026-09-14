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
			setCurrentRepoPath: (() => {}) as never,
			setCurrentBranch: (() => {}) as never,
		});

	// `TerminalData.repoPath` is the owning repo of record — the field
	// `reconcileTerminalOwnership` trusts over the branch arrays, where `null`
	// means "no registered repo claims this cwd, the placement is a guess". This
	// path is the opposite of a guess: it is handed the repo. Leaving the field
	// null here filed a deliberately placed terminal as parked.
	it("records the owning repo on a terminal it adds to a branch", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setBranch("/Gits/alpha", "main", { worktreePath: "/Gits/alpha" });
			repositoriesStore.setActiveBranch("/Gits/alpha", "main");

			const id = await makeCoordinator().handleAddTerminalToBranch("/Gits/alpha", "main");

			expect(id).toBeTruthy();
			expect(terminalsStore.get(id!)?.repoPath).toBe("/Gits/alpha");
			expect(repositoriesStore.findOwnerForTerminal(id!)).toEqual({
				repoPath: "/Gits/alpha",
				branchName: "main",
			});
		});
	});

	it("does not create a terminal when the spawn budget is exhausted", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setBranch("/Gits/alpha", "main", { worktreePath: "/Gits/alpha" });

			const messages: string[] = [];
			const coordinator = createBranchSelectionCoordinator({
				repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
				pty: { canSpawn: async () => false },
				setStatusInfo: (message) => messages.push(message),
				getDefaultFontSize: () => 14,
				setCurrentRepoPath: (() => {}) as never,
				setCurrentBranch: (() => {}) as never,
			});

			expect(await coordinator.handleAddTerminalToBranch("/Gits/alpha", "main")).toBeUndefined();
			expect(terminalsStore.getIds()).toHaveLength(0);
			expect(messages).toEqual(["Max sessions reached (50)"]);
		});
	});
});
