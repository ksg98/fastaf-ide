import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";

describe("orphan unclosed-terminal count (critic-1188 r4)", () => {
	const setStatusInfo = vi.fn();
	const closeTerminalsInWorktree = vi.fn();
	const removeOrphanWorktree = vi.fn();
	const confirmOrphanCleanup = vi.fn();
	let assessments: Array<{
		path: string;
		safe: boolean;
		live_sessions?: Array<{ session_id: string; name: string }>;
	}>;
	let refresh: (repoPath?: string) => Promise<void>;

	beforeEach(() => {
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		for (const s of repoSettingsStore.getAll()) repoSettingsStore.remove(s.path);
		setStatusInfo.mockReset();
		closeTerminalsInWorktree.mockReset().mockResolvedValue(undefined);
		removeOrphanWorktree.mockReset().mockResolvedValue(undefined);
		confirmOrphanCleanup.mockReset().mockResolvedValue(true);
		assessments = [];
		const repo = {
			getInfo: vi.fn(async () => ({ branch: "main", is_git_repo: true })),
			getRepoStructure: vi.fn(async () => ({
				worktree_paths: { main: { branch: "main", path: "/repo", kind: "main" } },
				merged_branches: [],
			})),
			getRepoDiffStats: vi.fn().mockResolvedValue({ diff_stats: {}, last_commit_ts: {}, workspace_statuses: {} }),
			detectOrphanWorktrees: vi.fn().mockResolvedValue([]),
			assessOrphanCleanup: vi.fn(async () => assessments),
			beginOrphanCleanup: vi.fn().mockResolvedValue(undefined),
			pendingOrphanCleanupAnswer: vi.fn().mockResolvedValue(null),
			clearOrphanCleanup: vi.fn().mockResolvedValue(undefined),
			removeOrphanWorktree,
			getWorkspaceLifecycle: vi.fn(),
			finalizeMergedWorktree: vi.fn(),
		};
		const c = createRepositoryRefreshCoordinator({
			repo,
			dialogs: { confirmOrphanCleanup },
			closeTerminal: vi.fn(),
			closeTerminalsInWorktree,
			setStatusInfo,
		} as unknown as Parameters<typeof createRepositoryRefreshCoordinator>[0]);
		refresh = c.refreshAllBranchStats;
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setWorkspace("/repo", "main", { worktreePath: "/repo" });
		repoSettingsStore.getOrCreate("/repo", "Repo");
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
	});

	const failOne = () => new AggregateError([new Error("pty busy")], "1 terminal(s) could not be closed");

	// Catches: `unclosed += await removeOrphan()` reading the accumulator before the await, so
	// concurrent orphans overwrite each other and the status line under-reports (1 instead of 2).
	it("auto mode: unclosed terminals of two concurrently removed orphans are summed", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "on" });
		assessments = [
			{ path: "/wt/a", safe: true },
			{ path: "/wt/b", safe: true },
		];
		closeTerminalsInWorktree.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 5));
			throw failOne();
		});

		await refresh("/repo");

		expect(setStatusInfo).toHaveBeenCalledWith("Removed 2 orphaned worktree(s); 2 terminal(s) could not be closed");
	});

	// Catches: the same lost update in the Ask flow after the user confirmed several orphans.
	it("ask mode: unclosed terminals of two confirmed orphans are summed", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "ask" });
		assessments = [
			{ path: "/wt/a", safe: false, live_sessions: [{ session_id: "s1", name: "A" }] },
			{ path: "/wt/b", safe: false, live_sessions: [{ session_id: "s2", name: "B" }] },
		];
		closeTerminalsInWorktree.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 5));
			throw failOne();
		});

		await refresh("/repo");

		// The confirmed review runs detached from the refresh (FastAF): wait for it.
		await vi.waitFor(() =>
			expect(setStatusInfo).toHaveBeenCalledWith("Removed 2 orphaned worktree(s); 2 terminal(s) could not be closed"),
		);
	});

	// Catches: orphan A removed with a stuck terminal, orphan B's removal refused by the backend:
	// the count must stay 1 and the removed count 1 (a refused removal contributes nothing).
	it("a refused removal adds neither to removed nor to unclosed", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "on" });
		assessments = [
			{ path: "/wt/a", safe: true },
			{ path: "/wt/b", safe: true },
		];
		removeOrphanWorktree.mockImplementation(async (_r: string, p: string) => {
			if (p === "/wt/b") throw new Error("live session: late");
		});
		closeTerminalsInWorktree.mockRejectedValue(failOne());

		await refresh("/repo");

		expect(setStatusInfo).toHaveBeenCalledTimes(1);
		expect(setStatusInfo).toHaveBeenCalledWith("Removed 1 orphaned worktree(s); 1 terminal(s) could not be closed");
	});

	// Catches: Auto sweep reports an unclosed terminal, then the live-session review removal
	// overwrites the single status line with a clean "Removed 1", erasing the warning.
	it("auto mode: a later clean review removal does not erase the unclosed-terminal warning", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "on" });
		assessments = [
			{ path: "/wt/safe", safe: true },
			{ path: "/wt/live", safe: false, live_sessions: [{ session_id: "s1", name: "A" }] },
		];
		closeTerminalsInWorktree.mockImplementation(async (p: string) => {
			if (p === "/wt/safe") throw failOne();
		});

		await refresh("/repo");

		// The live-session review runs detached from the refresh (FastAF): wait for its line.
		await vi.waitFor(() => expect(setStatusInfo).toHaveBeenCalledTimes(1));
		const last = setStatusInfo.mock.calls.at(-1)?.[0] as string;
		expect(last).toContain("could not be closed");
	});
});
