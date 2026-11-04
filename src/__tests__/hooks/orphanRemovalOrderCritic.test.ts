import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";

describe("orphan removal order and session binding (critic-1188 r2)", () => {
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

	// Catches: closing the terminals before the backend verdict, so a refused removal
	// (session started after the assessment) kills the very terminal it protected.
	it("ask mode: a refused removal leaves the terminals of that checkout open", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "ask" });
		assessments = [{ path: "/wt/busy", safe: false, live_sessions: [{ session_id: "s1", name: "A" }] }];
		removeOrphanWorktree.mockRejectedValue(new Error("live session: B; not part of the confirmed removal"));

		await refresh("/repo");

		expect(removeOrphanWorktree).toHaveBeenCalled();
		expect(closeTerminalsInWorktree).not.toHaveBeenCalled();
	});

	// Catches: the same ordering bug in the unattended Auto sweep of a safe orphan.
	it("auto mode: a refused safe removal leaves the terminals open", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "on" });
		assessments = [{ path: "/wt/idle", safe: true }];
		removeOrphanWorktree.mockRejectedValue(new Error("live session: late"));

		await refresh("/repo");

		expect(closeTerminalsInWorktree).not.toHaveBeenCalled();
		expect(setStatusInfo).not.toHaveBeenCalled();
	});

	// Catches: a terminal-close failure after the checkout is already gone being counted
	// as "not removed", so the status line under-reports a removal that happened.
	it("counts a removed checkout even when closing its terminals throws afterwards", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "on" });
		assessments = [{ path: "/wt/idle", safe: true }];
		closeTerminalsInWorktree.mockRejectedValue(new Error("pty gone"));

		await refresh("/repo");

		expect(removeOrphanWorktree).toHaveBeenCalledWith("/repo", "/wt/idle", true);
		expect(setStatusInfo).toHaveBeenCalledWith("Removed 1 orphaned worktree(s); 1 terminal(s) could not be closed");
	});

	// Catches: sending an undefined/absent session list for an unsafe (dirty) orphan with no
	// sessions, which the transport would serialize inconsistently across IPC and HTTP.
	it("ask mode: an unsafe orphan without live_sessions confirms with an explicit empty list", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "ask" });
		assessments = [{ path: "/wt/dirty", safe: false }];

		await refresh("/repo");

		expect(removeOrphanWorktree).toHaveBeenCalledWith("/repo", "/wt/dirty", false, []);
	});

	// Catches: binding the confirmation to the union of all dialog rows, so a session
	// reviewed for orphan A also licenses removal of orphan B.
	it("ask mode: each orphan is confirmed with only its own reviewed sessions", async () => {
		repoSettingsStore.update("/repo", { orphanCleanup: "ask" });
		assessments = [
			{ path: "/wt/a", safe: false, live_sessions: [{ session_id: "sa", name: "A" }] },
			{ path: "/wt/b", safe: false, live_sessions: [{ session_id: "sb", name: "B" }] },
		];

		await refresh("/repo");

		expect(removeOrphanWorktree).toHaveBeenCalledWith("/repo", "/wt/a", false, ["sa"]);
		expect(removeOrphanWorktree).toHaveBeenCalledWith("/repo", "/wt/b", false, ["sb"]);
	});
});
