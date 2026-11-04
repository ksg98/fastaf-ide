import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createRepositoryRefreshCoordinator } from "../../hooks/git/createRepositoryRefreshCoordinator";
import { repositoriesStore } from "../../stores/repositories";

const metadata = vi.hoisted(() => [] as Record<string, number>[]);
vi.mock("../../utils/perfTrace", () => ({
	timeBatch: (label: string, run: (end: () => void) => void, detail?: () => Record<string, number>) => {
		run(() => {});
		if (label.startsWith("git.refreshBatch:")) metadata.push(detail?.() ?? {});
	},
}));

afterEach(() => {
	for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
	repositoriesStore._testCancelPendingSave();
	metadata.length = 0;
});

it("feeds a journal-derived synthetic topology through real refresh reconciliation with numeric metadata", async () => {
	// Catches: the builder's shape drifting from the actual refresh consumer, or counts
	// and bytes being omitted at the producer even though timeBatch accepts them.
	const journal = JSON.stringify({
		schema_version: 1,
		timestamp_ms: 1234,
		kind: "git_refresh",
		metrics: { repo_count: 16, worktree_count: 40, response_bytes: 12345 },
	});
	const fixture = JSON.parse(
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				'import {buildStallReplay} from "./scripts/build-stall-replay.mjs"; import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify(buildStallReplay(readFileSync(0,"utf8"))));',
			],
			{ cwd: process.cwd(), input: journal, encoding: "utf8" },
		),
	);
	const structure = fixture.refreshes[0].structure;
	for (let i = 0; i < fixture.refreshes[0].repo_count; i++) {
		repositoriesStore.add({ path: `/replay/repo-${i}`, displayName: `Replay ${i}` });
	}
	const refresh = createRepositoryRefreshCoordinator({
		repo: {
			getInfo: vi.fn(async () => ({ branch: "main", is_git_repo: true })),
			getRepoStructure: vi.fn(async () => structure),
			getRepoDiffStats: vi.fn(async () => ({ diff_stats: {}, last_commit_ts: {}, workspace_statuses: {} })),
			detectOrphanWorktrees: vi.fn(async () => []),
			assessOrphanCleanup: vi.fn(async () => []),
			beginOrphanCleanup: vi.fn(async () => {}),
			pendingOrphanCleanupAnswer: vi.fn(async () => null),
			clearOrphanCleanup: vi.fn(async () => {}),
			removeOrphanWorktree: vi.fn(async () => {}),
			getWorkspaceLifecycle: vi.fn(),
			sweepArchiveRetention: vi.fn().mockResolvedValue({ deleted: [], kept: [] }),
			finalizeMergedWorktree: vi.fn(),
		},
		dialogs: {},
		closeTerminal: vi.fn(async () => {}),
		closeTerminalsInWorktree: vi.fn(async () => {}),
		setStatusInfo: vi.fn(),
	});
	await refresh.refreshAllBranchStats("/replay/repo-0");
	expect(Object.keys(repositoriesStore.get("/replay/repo-0")!.workspaces)).toHaveLength(40);
	expect(metadata).toEqual([
		{
			repo_count: 16,
			worktree_count: 40,
			store_worktree_count: 40,
			response_bytes: Buffer.byteLength(JSON.stringify(structure)),
		},
	]);
	// The observed byte size is not a claim that synthetic names reproduce it.
	expect(metadata[0].response_bytes).not.toBe(12345);
});
