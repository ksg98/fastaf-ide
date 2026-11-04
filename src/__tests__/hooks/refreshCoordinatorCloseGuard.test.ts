import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

type Wt = { branch: string; path: string; kind: "worktree" | "main" };

function snapshot(entries: Record<string, string>): Record<string, Wt> {
	return Object.fromEntries(
		Object.entries(entries).map(([id, path]) => [
			id,
			{ branch: id, path, kind: path === "/repo" ? ("main" as const) : ("worktree" as const) },
		]),
	);
}

describe("refresh coordinator close guard (#1317, critic)", () => {
	const closeTerminal = vi.fn().mockResolvedValue(undefined);
	let structure: Record<string, string>;
	let refresh: (repoPath?: string) => Promise<void>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
		closeTerminal.mockClear();
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		structure = { main: "/repo" };
		const repo = {
			// Only the main checkout exists on disk: linked worktrees in these cases are really deleted.
			getInfo: vi.fn(async (path: string) => ({ branch: "main", is_git_repo: path === "/repo" })),
			getRepoStructure: vi.fn(async () => ({ worktree_paths: snapshot(structure), merged_branches: [] })),
			getRepoDiffStats: vi.fn().mockResolvedValue({ diff_stats: {}, last_commit_ts: {}, workspace_statuses: {} }),
			detectOrphanWorktrees: vi.fn().mockResolvedValue([]),
			assessOrphanCleanup: vi.fn().mockResolvedValue([]),
			beginOrphanCleanup: vi.fn().mockResolvedValue(undefined),
			pendingOrphanCleanupAnswer: vi.fn().mockResolvedValue(null),
			clearOrphanCleanup: vi.fn().mockResolvedValue(undefined),
			removeOrphanWorktree: vi.fn().mockResolvedValue(undefined),
			getWorkspaceLifecycle: vi.fn(),
			finalizeMergedWorktree: vi.fn(),
		};
		const c = createRepositoryRefreshCoordinator({
			repo,
			dialogs: {},
			closeTerminal,
			closeTerminalsInWorktree: vi.fn().mockResolvedValue(undefined),
			setStatusInfo: vi.fn(),
		} as unknown as Parameters<typeof createRepositoryRefreshCoordinator>[0]);
		refresh = c.refreshAllBranchStats;
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setWorkspace("/repo", "main", { worktreePath: "/repo" });
	});

	afterEach(() => {
		vi.useRealTimers();
		repositoriesStore._testCancelPendingSave();
	});

	function addWorktreeWithTerminal(id: string, path: string): string {
		repositoriesStore.setWorkspace("/repo", id, { worktreePath: path, kind: "worktree" });
		const tid = terminalsStore.add(makeTerminal({ name: id, sessionId: `s-${id}`, cwd: path }));
		repositoriesStore.addTerminalToWorkspace("/repo", id, tid);
		return tid;
	}

	it("re-homes a fresh worktree's terminal at once when its branch is switched inside the grace window", async () => {
		// Bug caught: the new grace skips the workspace before the same-path replacement
		// check, so a branch switch (agent runs `git checkout -b` right after spawn) leaves
		// the terminal on a stale row next to a duplicate row for the same directory.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // first refresh of the repo
		const tid = addWorktreeWithTerminal("fresh", "/repo/.worktrees/fresh");
		structure = { main: "/repo", fresh: "/repo/.worktrees/fresh" };
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // stamps "fresh" as first seen now

		vi.advanceTimersByTime(5_000);
		structure = { main: "/repo", renamed: "/repo/.worktrees/fresh" };
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");

		const ws = repositoriesStore.get("/repo")?.workspaces ?? {};
		expect(ws.fresh).toBeUndefined();
		expect(ws.renamed?.terminals).toContain(tid);
		expect(closeTerminal).not.toHaveBeenCalled();
	});

	it("keeps both workspaces of a second burst and prunes a really deleted one of the first burst after the grace", async () => {
		// Bug caught: a single global stamp (or one reset by the second burst) either
		// protects the first burst forever or prunes the second one early.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const a = addWorktreeWithTerminal("wt-a", "/repo/.worktrees/a");
		structure = { main: "/repo" }; // stale snapshot: predates a
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		expect(closeTerminal).not.toHaveBeenCalled();

		vi.advanceTimersByTime(30_000);
		const b = addWorktreeWithTerminal("wt-b", "/repo/.worktrees/b");
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // still stale for both
		expect(closeTerminal).not.toHaveBeenCalled();

		vi.advanceTimersByTime(31_000); // only a is past the grace; snapshot has neither
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		expect(closeTerminal).toHaveBeenCalledTimes(1);
		expect(closeTerminal).toHaveBeenCalledWith(a, true);
		expect(closeTerminal).not.toHaveBeenCalledWith(b, true);
		expect(repositoriesStore.get("/repo")?.workspaces["wt-b"]).toBeDefined();
	});

	it("does not reset a workspace's age when it stays in the store across many refreshes", async () => {
		// Bug caught: re-stamping on every refresh keeps a really deleted worktree
		// immortal while refreshes keep arriving more often than the grace.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const a = addWorktreeWithTerminal("wt-a", "/repo/.worktrees/a");
		for (let i = 0; i < 7; i++) {
			vi.advanceTimersByTime(5_000);
			await refresh("/repo");
			vi.advanceTimersByTime(10_000);
		}
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // beyond the creation grace, still absent from every snapshot
		expect(closeTerminal).toHaveBeenCalledWith(a, true);
	});

	it("re-stamps a workspace that was removed and re-added under the same id", async () => {
		// Bug caught: the stamp survives removal, so a re-created worktree with a reused
		// id is judged against the old creation time and closed on the first stale snapshot.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		addWorktreeWithTerminal("wt-a", "/repo/.worktrees/a");
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		vi.advanceTimersByTime(120_000);
		repositoriesStore.removeWorkspace("/repo", "wt-a");
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // stamp dropped
		const again = addWorktreeWithTerminal("wt-a", "/repo/.worktrees/a");
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // snapshot predates the re-creation
		expect(closeTerminal).not.toHaveBeenCalledWith(again, true);
	});
});
