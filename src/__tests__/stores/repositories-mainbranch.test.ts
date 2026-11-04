import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { repositoriesStore as StoreType } from "../../stores/repositories";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);

let store: typeof StoreType;

describe("setWorkspace isMain defaulting", () => {
	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);

		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: mockInvoke,
		}));

		store = (await import("../../stores/repositories")).repositoriesStore;
		store._testSetHydrated(true);
	});

	afterEach(() => {
		store._testCancelPendingSave();
	});

	it("defaults isMain=true for main branches", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			for (const name of ["main", "master", "develop", "development", "dev"]) {
				store.setWorkspace("/repo", name);
				expect(store.get("/repo")!.workspaces[name].isMain).toBe(true);
			}
		});
	});

	it("is case-insensitive", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			for (const name of ["Main", "MASTER", "Develop", "DEVELOPMENT", "DEV"]) {
				store.setWorkspace("/repo", name);
				expect(store.get("/repo")!.workspaces[name].isMain).toBe(true);
			}
		});
	});

	it("defaults isMain=false for feature branches", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			for (const name of ["feature/foo", "feature/main", "bugfix/master-fix"]) {
				store.setWorkspace("/repo", name);
				expect(store.get("/repo")!.workspaces[name].isMain).toBe(false);
			}
		});
	});

	it("defaults isMain=false for other branches", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			for (const name of ["staging", "release/1.0", "hotfix/urgent"]) {
				store.setWorkspace("/repo", name);
				expect(store.get("/repo")!.workspaces[name].isMain).toBe(false);
			}
		});
	});

	it("respects explicit isMain from caller (Rust backend value)", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			// Override: feature branch marked as main by backend
			store.setWorkspace("/repo", "feature/custom", { isMain: true });
			expect(store.get("/repo")!.workspaces["feature/custom"].isMain).toBe(true);

			// Override: main branch explicitly marked not-main
			store.setWorkspace("/repo", "main", { isMain: false });
			expect(store.get("/repo")!.workspaces["main"].isMain).toBe(false);
		});
	});
});

/**
 * `make dev` never restarts the Rust side, so a reloaded frontend can talk to a
 * backend one commit behind it. That happened here: `get_repo_structure` still
 * answered `worktree_paths` as branch → path (a string), the refresh
 * coordinator read `wt.branch` and `wt.path` off that string, and every refresh
 * passed `{ branchName: undefined, worktreePath: undefined }` down to
 * `setWorkspace`. The spread put those over the defaults, the debounced save wrote
 * them out, and `compareBranches` then threw `a.branchName.localeCompare` on
 * every sidebar render — 31 of 38 repos on disk.
 *
 * The skew is the caller's problem. Persisting it was this store's.
 */
describe("setWorkspace ignores fields a partial update leaves undefined", () => {
	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		store = (await import("../../stores/repositories")).repositoriesStore;
		store._testSetHydrated(true);
	});

	afterEach(() => {
		store._testCancelPendingSave();
	});

	/** What the coordinator builds when it reads `wt.branch`/`wt.path` off a string. */
	const skewedUpdate = { worktreePath: undefined, branchName: undefined, isMerged: false };

	it("keeps the defaults when creating a branch", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });

			store.setWorkspace("/repo", "main", skewedUpdate);

			const workspace = store.get("/repo")!.workspaces["main"];
			expect(workspace.branchName).toBe("main");
			expect(workspace.workspaceId).toBe("main");
			expect(workspace.isMerged).toBe(false);
		});
	});

	it("keeps the stored value when updating a branch", () => {
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });
			store.setWorkspace("/repo", "wt~a1b2", {
				branchName: "feat/identity",
				worktreePath: "/repo__wt/feat-identity",
			});

			store.setWorkspace("/repo", "wt~a1b2", skewedUpdate);

			const workspace = store.get("/repo")!.workspaces["wt~a1b2"];
			expect(workspace.branchName).toBe("feat/identity");
			expect(workspace.worktreePath).toBe("/repo__wt/feat-identity");
		});
	});

	it("still writes a field a caller sets to null", () => {
		// null is a value the schema allows and a caller means; only undefined
		// is "not named". Dropping both would make a worktree unclearable.
		testInScope(() => {
			store.add({ path: "/repo", displayName: "repo" });
			store.setWorkspace("/repo", "main", { worktreePath: "/repo__wt/main" });

			store.setWorkspace("/repo", "main", { worktreePath: null });

			expect(store.get("/repo")!.workspaces["main"].worktreePath).toBeNull();
		});
	});
});
