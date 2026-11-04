import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

type Probe = (path: string) => Promise<{ branch: string; is_git_repo: boolean }>;

describe("refresh coordinator checkout probe (#1317, critic round 2)", () => {
	const closeTerminal = vi.fn().mockResolvedValue(undefined);
	let structure: Record<string, string>;
	let probe: Probe;
	let refresh: (repoPath?: string) => Promise<void>;

	const snapshot = () =>
		Object.fromEntries(
			Object.entries(structure).map(([id, path]) => [
				id,
				{ branch: id, path, kind: path === "/repo" ? ("main" as const) : ("worktree" as const) },
			]),
		);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
		closeTerminal.mockClear();
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		structure = { main: "/repo" };
		probe = async (path) => ({ branch: "main", is_git_repo: path === "/repo" });
		const repo = {
			getInfo: vi.fn((path: string) => probe(path)),
			getRepoStructure: vi.fn(async () => ({ worktree_paths: snapshot(), merged_branches: [] })),
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

	/** Let a refresh stamp the workspaces just added, then pass the creation grace so only the probe decides. */
	async function ageOut(): Promise<void> {
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		vi.advanceTimersByTime(61_000);
	}

	// Catches: stale sidebar membership kills a repo-root coordinator on worktree removal.
	it("preserves a repo-root tab misfiled under a removed worktree", async () => {
		const tid = addWorktreeWithTerminal("gone", "/wt/gone");
		terminalsStore.update(tid, { cwd: "/repo", placementPath: "/wt/gone" });
		await refresh("/repo");
		expect(closeTerminal).not.toHaveBeenCalledWith(tid, true);
		expect(terminalsStore.get(tid)).toBeDefined();
		expect(repositoriesStore.findOwnerForTerminal(tid)?.workspaceId).toBe("main");
		expect(repositoriesStore.get("/repo")?.workspaces.gone).toBeUndefined();
	});

	// Catches: a cwd read before the asynchronous checkout probe kills a terminal that left it.
	it("preserves a terminal that leaves the worktree while its checkout probe is pending", async () => {
		const tid = addWorktreeWithTerminal("gone", "/wt/gone");
		probe = async () => {
			terminalsStore.update(tid, { cwd: "/repo" });
			return { branch: "", is_git_repo: false };
		};
		await refresh("/repo");
		expect(closeTerminal).not.toHaveBeenCalledWith(tid, true);
		expect(repositoriesStore.findOwnerForTerminal(tid)?.workspaceId).toBe("main");
	});

	it("a really deleted worktree is closed and its row removed in the same refresh", async () => {
		// Bug caught: the probe reads "keep" for a path that is gone (inverted is_git_repo),
		// leaving a ghost row with a dead terminal forever.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const tid = addWorktreeWithTerminal("gone", "/wt/gone");
		await ageOut();
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		expect(closeTerminal).toHaveBeenCalledWith(tid, true);
		expect(repositoriesStore.get("/repo")?.workspaces.gone).toBeUndefined();
	});

	it("a probe that never settles does not stall the repo refresh or close anything", async () => {
		// Bug caught: isCheckoutGone has no timeout; a hung getInfo (dead network mount, stuck
		// git status) parks refreshInFlight for the repo, so every later refresh joins a run
		// that never ends and the sidebar/git panel stop updating until restart.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const tid = addWorktreeWithTerminal("hung", "/wt/hung");
		await ageOut();
		let finishProbe!: (value: Awaited<ReturnType<Probe>>) => void;
		probe = () =>
			new Promise((resolve) => {
				finishProbe = resolve;
			});
		const settled = vi.fn();
		void refresh("/repo").then(settled);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(settled).toHaveBeenCalled();
		expect(closeTerminal).not.toHaveBeenCalledWith(tid, true);
		finishProbe({ branch: "main", is_git_repo: true });
		await Promise.resolve();
	});

	// Catches: a timed-out probe's late absence/error closes a preserved terminal or
	// leaves the single-flight refresh stuck, preventing a fresh verdict from applying.
	it.each(["absent", "rejected"] as const)(
		"ignores a late %s probe after timeout and accepts the next refresh",
		async (late) => {
			vi.advanceTimersByTime(5_000);
			await refresh("/repo");
			const tid = addWorktreeWithTerminal("late", "/wt/late");
			await ageOut();
			let finish!: (value: Awaited<ReturnType<Probe>>) => void;
			let fail!: (reason: Error) => void;
			probe = () =>
				new Promise((resolve, reject) => {
					finish = resolve;
					fail = reject;
				});
			const timedOut = refresh("/repo");
			await vi.advanceTimersByTimeAsync(5_000);
			await timedOut;
			if (late === "absent") finish({ branch: "", is_git_repo: false });
			else fail(new Error("late IPC failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect(closeTerminal).not.toHaveBeenCalled();
			expect(repositoriesStore.get("/repo")?.workspaces.late?.terminals).toContain(tid);
			probe = async () => ({ branch: "", is_git_repo: false });
			vi.advanceTimersByTime(5_000);
			await refresh("/repo");
			expect(closeTerminal).toHaveBeenCalledExactlyOnceWith(tid, true);
			expect(repositoriesStore.get("/repo")?.workspaces.late).toBeUndefined();
		},
	);

	it("probes a burst of omitted worktrees concurrently, not one after the other", async () => {
		// Bug caught: the probe is awaited inside the per-workspace loop, so the refresh (and
		// everything queued behind it) takes N x probe latency; 12 slow `git status` probes of
		// 2s stall structure reconciliation for 24s.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		for (let i = 0; i < 12; i++) addWorktreeWithTerminal(`w${i}`, `/wt/w${i}`);
		await ageOut();
		probe = (path) =>
			new Promise((resolve) => setTimeout(() => resolve({ branch: "x", is_git_repo: path === "/repo" }), 2_000));
		const settled = vi.fn();
		void refresh("/repo").then(settled);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(settled).toHaveBeenCalled();
	});

	it("in a burst, a failing or live probe keeps only its own worktree and the gone ones still close", async () => {
		// Bug caught: one probe's verdict (or throw) leaks to the others — an exception aborts
		// the loop and strands the really deleted rows, or one live answer keeps them all.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const live = addWorktreeWithTerminal("live", "/wt/live");
		const boom = addWorktreeWithTerminal("boom", "/wt/boom");
		const gone1 = addWorktreeWithTerminal("gone1", "/wt/gone1");
		const gone2 = addWorktreeWithTerminal("gone2", "/wt/gone2");
		await ageOut();
		probe = async (path) => {
			if (path === "/wt/boom") throw new Error("ipc failed");
			return { branch: "x", is_git_repo: path === "/repo" || path === "/wt/live" };
		};
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const closed = closeTerminal.mock.calls.map((c) => c[0]).sort();
		expect(closed).toEqual([gone1, gone2].sort());
		const ws = repositoriesStore.get("/repo")?.workspaces ?? {};
		expect(ws.live?.terminals).toContain(live);
		expect(ws.boom?.terminals).toContain(boom);
		expect(ws.gone1).toBeUndefined();
		expect(ws.gone2).toBeUndefined();
	});

	it("a worktree kept by a live probe is judged again by the next refresh once it is gone", async () => {
		// Bug caught: the keep path marks the branch as processed (or stamps it), so the
		// checkout deleted a moment later is never closed and the ghost row is immortal.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo"); // the repo's first refresh: later additions get a real first-seen stamp
		const tid = addWorktreeWithTerminal("late", "/wt/late");
		await ageOut();
		probe = async () => ({ branch: "x", is_git_repo: true });
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		expect(closeTerminal).not.toHaveBeenCalled();
		probe = async (path) => ({ branch: "x", is_git_repo: path === "/repo" });
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		expect(closeTerminal).toHaveBeenCalledWith(tid, true);
		expect(repositoriesStore.get("/repo")?.workspaces.late).toBeUndefined();
	});

	it("a path reused by a new worktree re-homes the old row's terminals without asking the probe", async () => {
		// Bug caught: the probe (live because the NEW checkout sits on the old path) runs before
		// the same-path replacement, so the old row is neither re-homed nor closed and a
		// duplicate row lives next to it.
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const tid = addWorktreeWithTerminal("old", "/wt/reused");
		await ageOut();
		structure = { main: "/repo", fresh: "/wt/reused" };
		probe = async () => ({ branch: "x", is_git_repo: true });
		vi.advanceTimersByTime(5_000);
		await refresh("/repo");
		const ws = repositoriesStore.get("/repo")?.workspaces ?? {};
		expect(ws.old).toBeUndefined();
		expect(ws.fresh?.terminals).toContain(tid);
		expect(closeTerminal).not.toHaveBeenCalled();
	});
});
