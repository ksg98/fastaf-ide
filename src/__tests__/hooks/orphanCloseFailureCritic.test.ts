import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { createWorktreeWorkflowCoordinator } from "../../hooks/git/createWorktreeWorkflowCoordinator";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

// Real closeTerminalsInWorktree (workflow coordinator) wired into the refresh coordinator.
function setup(closeTerminal: (id: string, skip?: boolean) => Promise<void>) {
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
	repositoriesStore.add({ path: "/repo", displayName: "Repo" });
	repositoriesStore.setWorkspace("/repo", "main", { worktreePath: "/repo" });
	repoSettingsStore.getOrCreate("/repo", "Repo");
	repoSettingsStore.update("/repo", { orphanCleanup: "on" });
	const workflow = createWorktreeWorkflowCoordinator({ closeTerminal } as unknown as Parameters<
		typeof createWorktreeWorkflowCoordinator
	>[0]);
	const setStatusInfo = vi.fn();
	const repo = {
		getInfo: vi.fn(async () => ({ branch: "main", is_git_repo: true })),
		getRepoStructure: vi.fn(async () => ({
			worktree_paths: { main: { branch: "main", path: "/repo", kind: "main" } },
			merged_branches: [],
		})),
		getRepoDiffStats: vi.fn().mockResolvedValue({ diff_stats: {}, last_commit_ts: {}, workspace_statuses: {} }),
		detectOrphanWorktrees: vi.fn().mockResolvedValue([]),
		assessOrphanCleanup: vi.fn().mockResolvedValue([{ path: "/wt/gone", safe: true }]),
		beginOrphanCleanup: vi.fn(),
		pendingOrphanCleanupAnswer: vi.fn().mockResolvedValue(null),
		clearOrphanCleanup: vi.fn(),
		removeOrphanWorktree: vi.fn().mockResolvedValue(undefined),
		getWorkspaceLifecycle: vi.fn(),
		finalizeMergedWorktree: vi.fn(),
	};
	const c = createRepositoryRefreshCoordinator({
		repo,
		dialogs: {},
		closeTerminal,
		closeTerminalsInWorktree: workflow.closeTerminalsInWorktree,
		setStatusInfo,
	} as unknown as Parameters<typeof createRepositoryRefreshCoordinator>[0]);
	return { c, setStatusInfo };
}

describe("orphan removal, terminal close failure (#1188 round 3 critic)", () => {
	// Catches: the first failing close aborting the loop, so every later terminal on the removed
	// checkout stays alive although the removal is already counted as a success.
	it("one terminal that will not close does not stop the others in the same worktree closing", async () => {
		const closed: string[] = [];
		let first = true;
		const closeTerminal = vi.fn(async (id: string) => {
			if (first) {
				first = false;
				throw new Error("pty busy");
			}
			closed.push(id);
		});
		const { c } = setup(closeTerminal);
		const a = terminalsStore.add(makeTerminal({ name: "A", cwd: "/wt/gone" }));
		const b = terminalsStore.add(makeTerminal({ name: "B", cwd: "/wt/gone/sub" }));

		await c.refreshAllBranchStats();

		expect(closeTerminal).toHaveBeenCalledWith(a, true);
		expect(closeTerminal).toHaveBeenCalledWith(b, true);
	});

	// Catches: terminals left alive on a deleted checkout with only a log line, so the status line
	// claims a clean removal.
	it("a close failure after removal is visible in the status line, not only in the log", async () => {
		const closeTerminal = vi.fn().mockRejectedValue(new Error("pty busy"));
		const { c, setStatusInfo } = setup(closeTerminal);
		terminalsStore.add(makeTerminal({ name: "A", cwd: "/wt/gone" }));

		await c.refreshAllBranchStats();

		const messages = setStatusInfo.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => /terminal/i.test(m))).toBe(true);
	});

	// Catches: a sibling path sharing the prefix (/wt/gone2) being closed with the removed /wt/gone.
	it("does not close a terminal in a sibling worktree whose path shares the prefix", async () => {
		const closeTerminal = vi.fn().mockResolvedValue(undefined);
		const { c } = setup(closeTerminal);
		terminalsStore.add(makeTerminal({ name: "Sibling", cwd: "/wt/gone2" }));

		await c.refreshAllBranchStats();

		expect(closeTerminal).not.toHaveBeenCalled();
	});
});

afterEach(() => {
	repositoriesStore._testCancelPendingSave();
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
});
