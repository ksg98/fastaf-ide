import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(() => Promise.resolve(null)),
}));

import { makeTerminal, testInScope } from "../helpers/store";

/**
 * Per-repo worktree consolidation (#e767) — the selection rule and the reactive
 * glue. What lands in a repo's workspace is "every terminal of every branch that
 * has a worktree", recomputed from scratch, so create/remove/archive all fall
 * out of the same code path.
 */
describe("worktree consolidation", () => {
	let hook: typeof import("../../hooks/useWorktreeConsolidation");
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let repoSettingsStore: typeof import("../../stores/repoSettings").repoSettingsStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.resetModules();
		hook = await import("../../hooks/useWorktreeConsolidation");
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		repoSettingsStore = (await import("../../stores/repoSettings")).repoSettingsStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		(await import("../../stores/paneLayout")).resetGroupCounter();
	});

	const REPO = "/repo/a";

	/** Register a repo with a main branch and `worktrees` worktree branches. */
	function seedRepo(worktrees: string[]): Record<string, string> {
		repositoriesStore.add({ path: REPO, displayName: "a" });
		repositoriesStore.setBranch(REPO, "main", { isMain: true, worktreePath: null });
		const ids: Record<string, string> = {};
		for (const name of worktrees) {
			repositoriesStore.setBranch(REPO, name, { worktreePath: `/wt/${name}` });
			const termId = terminalsStore.add(makeTerminal({ name }));
			repositoriesStore.addTerminalToBranch(REPO, name, termId);
			ids[name] = termId;
		}
		return ids;
	}

	it("selects the terminals of worktree branches only", () => {
		testInScope(() => {
			const ids = seedRepo(["feat-1", "feat-2"]);
			// The main branch has no worktreePath, so its terminals stay out.
			const mainTerm = terminalsStore.add(makeTerminal({ name: "main" }));
			repositoriesStore.addTerminalToBranch(REPO, "main", mainTerm);

			const selected = hook.worktreeTerminalsOf(REPO);

			expect(selected.sort()).toEqual([ids["feat-1"], ids["feat-2"]].sort());
			expect(selected).not.toContain(mainTerm);
		});
	});

	it("returns nothing for a repo it has never seen", () => {
		testInScope(() => {
			expect(hook.worktreeTerminalsOf("/repo/never")).toEqual([]);
		});
	});

	it("lists only the repos whose toggle is on", () => {
		testInScope(() => {
			repoSettingsStore.getOrCreate(REPO, "a");
			repoSettingsStore.getOrCreate("/repo/b", "b");
			expect(hook.consolidatedRepos()).toEqual([]);

			repoSettingsStore.update(REPO, { autoConsolidateWorktrees: true });

			expect(hook.consolidatedRepos()).toEqual([REPO]);
		});
	});

	it("defaults the toggle to off so no repo consolidates unasked", () => {
		testInScope(() => {
			const created = repoSettingsStore.getOrCreate(REPO, "a");
			expect(created.autoConsolidateWorktrees).toBe(false);
		});
	});
});
