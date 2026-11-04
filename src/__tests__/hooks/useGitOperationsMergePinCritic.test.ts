import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitOperations } from "../../hooks/useGitOperations";
import { diffTabsStore } from "../../stores/diffTabs";
import { editorTabsStore } from "../../stores/editorTabs";
import { githubStore } from "../../stores/github";
import { mdTabsStore } from "../../stores/mdTabs";
import { paneLayoutStore, resetGroupCounter } from "../../stores/paneLayout";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import type { BranchPrStatus } from "../../types";
import { mockInvoke } from "../mocks/tauri";

function resetStores() {
	for (const id of terminalsStore.getIds()) {
		terminalsStore.remove(id);
	}
	for (const path of repositoriesStore.getPaths()) {
		repositoriesStore.remove(path);
	}
	for (const s of repoSettingsStore.getAll()) {
		repoSettingsStore.remove(s.path);
	}
	editorTabsStore.clearAll();
	diffTabsStore.clearAll();
	mdTabsStore.clearAll();
}

function defaultInvoke(cmd: string): Promise<unknown> {
	if (cmd === "load_agents_config") return Promise.resolve({ agents: {} });
	if (cmd === "run_git_command") return Promise.resolve({ stdout: "", stderr: "" });
	if (cmd === "check_worktree_dirty") return Promise.resolve(false);
	return Promise.resolve(undefined);
}

/** Build the id-keyed workspace map the backend now returns from a plain
 *  branch -> path object. Under the identity migration a git worktree's
 *  workspace id IS its branch, so the key is reused as the id and the branch
 *  travels as a field on the value (#726-5ac7). */
function wtPaths(byBranch: Record<string, string>): Record<string, { branch: string; path: string; kind: "worktree" }> {
	return Object.fromEntries(
		Object.entries(byBranch).map(([branch, path]) => [branch, { branch, path, kind: "worktree" }]),
	);
}

describe("useGitOperations", () => {
	const mockRepo = {
		getInfo: vi.fn(),
		getDiffStats: vi.fn().mockResolvedValue({ additions: 0, deletions: 0 }),
		getWorktreePaths: vi.fn().mockResolvedValue({}),
		getRepoSummary: vi
			.fn()
			.mockResolvedValue({ worktree_paths: wtPaths({}), merged_branches: [], diff_stats: {}, last_commit_ts: {} }),
		getRepoStructure: vi.fn().mockResolvedValue({ worktree_paths: wtPaths({}), merged_branches: [] }),
		getRepoDiffStats: vi.fn().mockResolvedValue({ diff_stats: {}, last_commit_ts: {} }),
		removeWorktree: vi.fn().mockResolvedValue(undefined),
		createWorktree: vi.fn(),
		renameBranch: vi.fn().mockResolvedValue(undefined),
		createBranch: vi.fn().mockResolvedValue(undefined),
		generateWorktreeName: vi.fn().mockResolvedValue("bold-nexus-042"),
		generateCloneBranchName: vi.fn().mockResolvedValue("feat-auth--bold-nexus-042"),
		listBaseRefOptions: vi.fn().mockResolvedValue([{ name: "main", kind: "local", is_default: true }]),
		mergeAndArchiveWorktree: vi.fn().mockResolvedValue({ merged: true, action: "archived", archive_path: null }),
		sweepArchiveRetention: vi.fn().mockResolvedValue({ deleted: [], kept: [] }),
		finalizeMergedWorktree: vi.fn().mockResolvedValue({ merged: true, action: "archived", archive_path: null }),
		listLocalBranches: vi.fn().mockResolvedValue(["main"]),
		getMergedBranches: vi.fn().mockResolvedValue(["main"]),
		checkoutRemoteBranch: vi.fn().mockResolvedValue(undefined),
		detectOrphanWorktrees: vi.fn().mockResolvedValue([]),
		assessOrphanCleanup: vi.fn(),
		beginOrphanCleanup: vi.fn().mockResolvedValue(undefined),
		pendingOrphanCleanupAnswer: vi.fn().mockResolvedValue(null),
		clearOrphanCleanup: vi.fn().mockResolvedValue(undefined),
		removeOrphanWorktree: vi.fn().mockResolvedValue(undefined),
		mergePrViaGithub: vi.fn().mockResolvedValue("abc123sha"),
		switchBranch: vi
			.fn()
			.mockResolvedValue({ success: true, stashed: false, previous_branch: "main", new_branch: "feature" }),
		runSetupScript: vi.fn().mockResolvedValue({ exit_code: 0, stdout: "", stderr: "" }),
		getWorkspaceLifecycle: vi.fn().mockResolvedValue({
			dirtyFingerprint: "confirmed-worktree",
			dirtyFiles: 0,
			commitStatus: "merged",
			removalSafety: "safe",
		}),
	};

	const mockPty = {
		canSpawn: vi.fn().mockResolvedValue(true),
		write: vi.fn().mockResolvedValue(undefined),
		getWorktreesDir: vi.fn().mockResolvedValue("/repos/.worktrees"),
	};

	const mockDialogs = {
		confirmRemoveRepo: vi.fn().mockResolvedValue(true),
		confirmRemoveWorktree: vi.fn().mockResolvedValue(true),
		confirmRemoveLockedWorktree: vi.fn().mockResolvedValue(true),
		confirmStashAndSwitch: vi.fn().mockResolvedValue(true),
		confirmDirtyWorktreeCleanup: vi.fn().mockResolvedValue(true),
		reportGitError: vi.fn().mockResolvedValue(false),
	};

	const mockCloseTerminal = vi.fn().mockResolvedValue(undefined);
	const mockCreateNewTerminal = vi.fn().mockResolvedValue("term-new");
	const mockSetStatusInfo = vi.fn();

	let gitOps: ReturnType<typeof useGitOperations>;

	beforeEach(() => {
		vi.useFakeTimers();
		resetStores();
		paneLayoutStore.reset();
		resetGroupCounter();
		vi.clearAllMocks();
		// Linked worktrees under /repo/ are gone from disk unless a test says otherwise.
		mockRepo.getInfo.mockReset();
		mockRepo.getInfo.mockImplementation(async (path: string) => {
			if (path.startsWith("/repo/")) return { branch: "", is_git_repo: false };
			throw new Error(`unmocked getInfo(${path})`);
		});
		mockRepo.pendingOrphanCleanupAnswer.mockResolvedValue(null);
		mockRepo.assessOrphanCleanup.mockImplementation(async (repoPath: string) =>
			(await mockRepo.detectOrphanWorktrees(repoPath)).map((path: string) => ({ path, safe: true })),
		);
		mockPty.canSpawn.mockResolvedValue(true);
		mockDialogs.confirmRemoveRepo.mockResolvedValue(true);
		mockDialogs.confirmRemoveWorktree.mockResolvedValue(true);
		mockDialogs.confirmRemoveLockedWorktree.mockResolvedValue(true);
		mockDialogs.confirmStashAndSwitch.mockResolvedValue(true);
		mockDialogs.reportGitError.mockResolvedValue(false);
		// The post-merge cleanup dialog asks two dirtiness questions before it opens.
		// Both fail SAFE (an unanswered question reads as dirty), so a bare
		// `resolves undefined` mock would make every ask-mode test look dirty.
		mockInvoke.mockImplementation(defaultInvoke);
		mockRepo.switchBranch.mockResolvedValue({
			success: true,
			stashed: false,
			previous_branch: "main",
			new_branch: "feature",
		});

		gitOps = useGitOperations({
			repo: mockRepo,
			pty: mockPty,
			dialogs: mockDialogs,
			closeTerminal: mockCloseTerminal,
			createNewTerminal: mockCreateNewTerminal,
			setStatusInfo: mockSetStatusInfo,
			getDefaultFontSize: () => 14,
			getMaxTabNameLength: () => 25,
		});
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setWorkspace("/repo", "main", { worktreePath: "/repo", isMain: true });
		repositoriesStore.setWorkspace("/repo", "feature/x", { worktreePath: "/repo/.wt/x" });
	});

	afterEach(() => {
		githubStore.updateRepoData("/repo", []);
		vi.useRealTimers();
		paneLayoutStore._testCancelPendingSave();
		repositoriesStore._testCancelPendingSave();
	});
	const testPr: BranchPrStatus = {
		branch: "feature/x",
		number: 99,
		title: "Add feature X",
		state: "OPEN",
		url: "https://github.com/owner/repo/pull/99",
		additions: 10,
		deletions: 5,
		checks: { passed: 1, failed: 0, pending: 0, total: 1 },
		check_details: [],
		author: "user",
		commits: 2,
		mergeable: "MERGEABLE",
		conflict_state: "clear" as const,
		merge_state_status: "CLEAN",
		review_decision: "APPROVED",
		viewer_did_approve: false,
		labels: [],
		is_draft: false,
		base_ref_name: "main",
		head_ref_oid: "abc1234",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-02T00:00:00Z",
		merge_state_label: null,
		review_state_label: null,
		merge_commit_allowed: true,
		squash_merge_allowed: true,
		rebase_merge_allowed: true,
		unresolved_threads: 0,
		unresolved_threads_truncated: false,
	};

	// Catches: a PR row without head_ref_oid reaches the backend as "", the backend refuses
	// ("Cannot merge without the head commit..."), and the coordinator treats that as a generic
	// GitHub failure and falls back to a local merge that has no head pin at all.
	it("does not fall back to an unpinned local merge when the PR row has no head sha", async () => {
		githubStore.updateRepoData("/repo", [{ ...testPr, head_ref_oid: "" }]);
		mockRepo.mergePrViaGithub.mockRejectedValueOnce(
			new Error("Cannot merge without the head commit the PR was reviewed at"),
		);

		await gitOps.handleMergeAndArchive("/repo", "feature/x", "main", "archive");

		expect(mockRepo.mergeAndArchiveWorktree).not.toHaveBeenCalled();
	});
});
