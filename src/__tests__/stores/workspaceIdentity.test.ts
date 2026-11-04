import { describe, expect, it } from "vitest";
import { generateWorkspaceId, migrateActiveWorkspaceId, migrateRepoWorkspaces } from "../../stores/workspaceIdentity";
import type { SavedTerminal } from "../../types";
import { compareBranches } from "../../utils/branchSort";
import { joinPath } from "../../utils/pathUtils";

/**
 * A record in the exact shape `repositories.json` holds today, captured from a
 * live config (35 repos): a main branch with no worktree, plus two worktree
 * branches — one of them with a `/` in its name, which is the case an id
 * generator that builds paths gets wrong.
 *
 * The migration's whole promise is that this document survives it unchanged
 * except for the key rename. If a field disappears here, a user loses tab
 * placement, diffstats or a saved run command on the next start.
 */
function legacyRepoRecord() {
	return {
		path: "/Users/x/Gits/acme",
		displayName: "acme",
		initials: "AC",
		isGitRepo: true,
		expanded: true,
		collapsed: false,
		parked: false,
		activeBranch: "main",
		branches: {
			main: {
				name: "main",
				isMain: true,
				worktreePath: null,
				terminals: [],
				hadTerminals: true,
				lastActiveTerminal: "term-1",
				additions: 0,
				deletions: 0,
				isMerged: false,
				lastCommitTs: 1788000000000,
				savedTerminals: [{ id: "term-1", name: "zsh", cwd: "/Users/x/Gits/acme", fontSize: 13, agentType: null }],
				tabsCollapsed: true,
			},
			"feat/shared-identity": {
				name: "feat/shared-identity",
				isMain: false,
				worktreePath: "/Users/x/Gits/acme__wt/feat-shared-identity",
				terminals: [],
				hadTerminals: false,
				lastActiveTerminal: null,
				additions: 12,
				deletions: 3,
				isMerged: false,
				lastCommitTs: 1788100000000,
				savedTerminals: [],
				runCommand: "pnpm dev",
			},
			"POC-000006": {
				name: "POC-000006",
				isMain: false,
				worktreePath: "/Users/x/Gits/acme__wt/POC-000006",
				terminals: [],
				hadTerminals: false,
				lastActiveTerminal: null,
				additions: 0,
				deletions: 0,
				isMerged: true,
				lastCommitTs: null,
				ciAutoHeal: { enabled: true, attempts: 2 },
			},
		},
	};
}

describe("workspace identity migration", () => {
	it("keys every existing entry by its own branch name — the migration is the identity function", () => {
		const workspaces = migrateRepoWorkspaces(legacyRepoRecord());

		expect(Object.keys(workspaces).sort()).toEqual(["POC-000006", "feat/shared-identity", "main"]);
		for (const [key, workspace] of Object.entries(workspaces)) {
			expect(workspace.workspaceId).toBe(key);
			expect(workspace.branchName).toBe(key);
		}
	});

	it("carries every persisted field across untouched", () => {
		const legacy = legacyRepoRecord();
		const workspaces = migrateRepoWorkspaces(legacy);

		const feature = workspaces["feat/shared-identity"];
		expect(feature.worktreePath).toBe("/Users/x/Gits/acme__wt/feat-shared-identity");
		expect(feature.additions).toBe(12);
		expect(feature.deletions).toBe(3);
		expect(feature.runCommand).toBe("pnpm dev");

		const main = workspaces.main;
		expect(main.savedTerminals).toEqual([
			{ id: "term-1", name: "zsh", cwd: "/Users/x/Gits/acme", fontSize: 13, agentType: null },
		]);
		expect(main.lastActiveTerminal).toBe("term-1");
		expect(main.tabsCollapsed).toBe(true);
		expect(main.lastCommitTs).toBe(1788000000000);

		expect(workspaces["POC-000006"].ciAutoHeal).toEqual({ enabled: true, attempts: 2 });
		expect(workspaces["POC-000006"].isMerged).toBe(true);
	});

	/**
	 * The one thing a key migration can break irrecoverably: a terminal filed
	 * under a key that no longer exists is invisible and unclosable — the tab is
	 * gone from the strip while its PTY is still running.
	 *
	 * Nothing is RE-bound here, and that is the point: because the migration is
	 * the identity function, no terminal ever has to move. This test exists to
	 * fail the day someone makes ids opaque for existing rows too.
	 */
	it("orphans no terminal — every terminal list stays under the key that held it", () => {
		const legacy = legacyRepoRecord();
		// The fixture is a captured JSON document, so TypeScript infers `never[]`
		// for its empty terminal arrays. This view is what the document actually
		// holds, not a widening of the migration's own input type.
		const branches = legacy.branches as unknown as Record<
			string,
			{ terminals: string[]; savedTerminals?: SavedTerminal[] }
		>;
		branches.main.terminals = ["term-1", "term-2"];
		branches["feat/shared-identity"].terminals = ["term-3"];

		const before = Object.fromEntries(
			Object.entries(branches).map(([key, b]) => [key, [...b.terminals, ...(b.savedTerminals ?? [])]]),
		);

		const after = Object.fromEntries(
			Object.entries(migrateRepoWorkspaces(legacy)).map(([key, w]) => [
				key,
				[...w.terminals, ...(w.savedTerminals ?? [])],
			]),
		);

		// Key-for-key equal: nothing moved, nothing was dropped, and no list ended
		// up under a key the store does not hold. `savedTerminals` rides along
		// because restore reads it — and it carries no terminal id of its own, so a
		// list left under a dead key could not be found by any other means.
		expect(after).toEqual(before);
		expect(after.main).toHaveLength(3); // two live + one saved
	});

	it("does not mutate the record it was given", () => {
		const legacy = legacyRepoRecord();
		const before = JSON.stringify(legacy);
		migrateRepoWorkspaces(legacy);
		expect(JSON.stringify(legacy)).toBe(before);
	});

	it("derives kind from the existing shape and leaves parentRepoPath null", () => {
		const workspaces = migrateRepoWorkspaces(legacyRepoRecord());

		expect(workspaces.main.kind).toBe("main");
		expect(workspaces["feat/shared-identity"].kind).toBe("worktree");
		expect(workspaces["POC-000006"].kind).toBe("worktree");
		for (const workspace of Object.values(workspaces)) {
			expect(workspace.parentRepoPath).toBeNull();
		}
	});

	it("is idempotent — a record already holding workspaces comes back unchanged", () => {
		const once = migrateRepoWorkspaces(legacyRepoRecord());
		const twice = migrateRepoWorkspaces({ workspaces: once });
		expect(twice).toEqual(once);
	});

	/**
	 * Captured from a live `repositories.json` (31 of 38 repos in this shape): a
	 * build that shipped a partial version of this migration wrote `workspaces`
	 * entries holding `workspaceId`, `kind` and `parentRepoPath` but neither
	 * `branchName` nor `worktreePath`.
	 *
	 * Those records skipped the repair on every later load, and the missing
	 * `branchName` made `compareBranches` throw inside the sidebar's sort memo —
	 * which Solid turned into an undefined memo and a whole-app crash at
	 * `sortedBranches().length`, a reader that names nothing about the cause.
	 */
	function partiallyMigratedRecord() {
		return {
			workspaces: {
				master: {
					workspaceId: "master",
					kind: "main" as const,
					parentRepoPath: null,
					isMain: true,
					terminals: [],
					hadTerminals: true,
					lastActiveTerminal: "term-69",
					additions: 0,
					deletions: 422,
					isMerged: false,
					lastCommitTs: 1788776823000,
				},
				"POC-00004-no-containers": {
					workspaceId: "POC-00004-no-containers",
					kind: "worktree" as const,
					parentRepoPath: null,
					isMain: false,
					terminals: [],
					hadTerminals: false,
					lastActiveTerminal: null,
					additions: 0,
					deletions: 0,
					isMerged: false,
					lastCommitTs: null,
				},
				"feat/ai-fingerprint-coverage": {
					workspaceId: "feat/ai-fingerprint-coverage",
					kind: "worktree" as const,
					parentRepoPath: null,
					isMain: false,
					terminals: [],
					hadTerminals: false,
					lastActiveTerminal: null,
					additions: 0,
					deletions: 0,
					isMerged: false,
					lastCommitTs: null,
				},
			},
		};
	}

	it("fills the identity fields a partially migrated record never got", () => {
		const workspaces = migrateRepoWorkspaces(partiallyMigratedRecord());

		expect(workspaces.master.branchName).toBe("master");
		expect(workspaces.master.worktreePath).toBeNull();
		expect(workspaces.master.workspaceId).toBe("master");
	});

	it("keeps a repaired record sortable — the crash was a throw inside the sort", () => {
		const workspaces = migrateRepoWorkspaces(partiallyMigratedRecord());

		// Two non-main workspaces: only this pair reaches the `localeCompare` that
		// threw. A sort that stops at the isMain check proves nothing.
		const [first, second] = Object.values(workspaces).filter((w) => !w.isMain);
		expect(() => compareBranches(first, second, undefined, undefined)).not.toThrow();

		const sorted = Object.values(workspaces).sort((a, b) => compareBranches(a, b, undefined, undefined));
		expect(sorted[0].branchName).toBe("master");
	});

	it("returns an empty map for a repo that has no entries at all", () => {
		expect(migrateRepoWorkspaces({})).toEqual({});
		expect(migrateRepoWorkspaces({ branches: {} })).toEqual({});
	});

	/**
	 * The exact record found in a live `repositories.json` after `get_worktree_paths`
	 * changed from `{branch: path}` to `{id: {branch, path}}`: a WebView still holding
	 * the pre-change module wrote the whole worktree record into `worktreePath`, and
	 * it round-tripped through every later load. The app then died on
	 * `base.replace is not a function` inside `joinPath`, from a FileBrowser render.
	 */
	it("drops a worktreePath a shape skew wrote as the whole worktree record", () => {
		const poisoned = {
			workspaces: {
				master: {
					name: "master",
					isMain: true,
					// Not a string — this is what `get_worktree_paths` returns per entry now.
					worktreePath: { branch: "master", path: "/Users/x/Gits/acme" } as unknown as string,
					terminals: [],
					hadTerminals: false,
					lastActiveTerminal: null,
					additions: 0,
					deletions: 0,
					isMerged: false,
					lastCommitTs: null,
				},
			},
		};

		const workspace = migrateRepoWorkspaces(poisoned).master;

		expect(workspace.worktreePath).toBeNull();
		// The crash was one `.replace` away from the record; prove the repaired value
		// survives the call that threw.
		expect(() => joinPath(workspace.worktreePath ?? "/Users/x/Gits/acme", "src")).not.toThrow();
	});

	it("keeps a branchName and parentRepoPath the same skew could corrupt", () => {
		const poisoned = {
			workspaces: {
				"main~a1b2c3d4": {
					branchName: { name: "main" } as unknown as string,
					parentRepoPath: { path: "/Users/x/Gits/acme" } as unknown as string,
					kind: "worktree" as const,
					isMain: false,
					terminals: [],
					hadTerminals: false,
					lastActiveTerminal: null,
					additions: 0,
					deletions: 0,
					isMerged: false,
					lastCommitTs: null,
				},
			},
		};

		const workspace = migrateRepoWorkspaces(poisoned)["main~a1b2c3d4"];

		expect(workspace.branchName).toBe("main~a1b2c3d4");
		expect(workspace.parentRepoPath).toBeNull();
		expect(() => compareBranches(workspace, workspace, undefined, undefined)).not.toThrow();
	});
});

describe("migrateActiveWorkspaceId", () => {
	it("carries the legacy activeBranch across as the active id", () => {
		expect(migrateActiveWorkspaceId(legacyRepoRecord())).toBe("main");
	});

	it("prefers an already-migrated activeWorkspaceId over the legacy field", () => {
		// A record another client already migrated must not be dragged backwards by
		// a stale `activeBranch` the older build left behind next to it.
		const record = { ...legacyRepoRecord(), activeWorkspaceId: "feat/shared-identity" };
		expect(migrateActiveWorkspaceId(record)).toBe("feat/shared-identity");
	});

	it("is null when neither field is set", () => {
		expect(migrateActiveWorkspaceId({})).toBeNull();
	});

	it("drops an active id that names no workspace", () => {
		// A branch removed in another window leaves the pointer dangling; keeping it
		// would index `workspaces` to undefined on every read.
		const record = { ...legacyRepoRecord(), activeBranch: "deleted-elsewhere" };
		expect(migrateActiveWorkspaceId(record)).toBeNull();
	});
});

describe("generateWorkspaceId", () => {
	it("produces a different id every time for the same branch", () => {
		const ids = new Set(Array.from({ length: 50 }, () => generateWorkspaceId("feat/x", [])));
		expect(ids.size).toBe(50);
	});

	it("sanitizes a branch name that would otherwise read as a path", () => {
		const id = generateWorkspaceId("feat/shared-identity", []);
		expect(id).not.toContain("/");
		expect(id).toMatch(/^feat-shared-identity~[0-9a-f]{8}$/);
	});

	it("never collides with an id already in use", () => {
		// Force the generator to notice a taken id rather than trusting randomness.
		const taken: string[] = [];
		for (let i = 0; i < 20; i++) taken.push(generateWorkspaceId("dup", taken));
		expect(new Set(taken).size).toBe(20);
	});

	it("keeps a branch name that is already safe intact ahead of the suffix", () => {
		expect(generateWorkspaceId("main", [])).toMatch(/^main~[0-9a-f]{8}$/);
	});
});
