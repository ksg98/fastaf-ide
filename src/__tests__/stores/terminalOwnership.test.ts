import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal, testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

describe("reconcileTerminalOwnership", () => {
	let reconcile: typeof import("../../stores/terminalOwnership").reconcileTerminalOwnership;
	let reclaimParked: typeof import("../../stores/terminalOwnership").reclaimParkedTerminal;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		reconcile = (await import("../../stores/terminalOwnership")).reconcileTerminalOwnership;
		reclaimParked = (await import("../../stores/terminalOwnership")).reclaimParkedTerminal;
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		repositoriesStore._testSetHydrated(true);
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
	});

	/** Register a repo with one branch checked out at its root. */
	const addRepoWithBranch = (path: string, branch: string, worktreePath = path) => {
		repositoriesStore.add({ path, displayName: path });
		repositoriesStore.setBranch(path, branch, { worktreePath });
		repositoriesStore.setActiveBranch(path, branch);
	};

	it("re-homes a parked terminal once the repo owning its cwd is registered", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			// The session lives in gate-os, which nobody has registered yet, so it was
			// parked in whatever repo was active and marked as a guess.
			const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/gate-os/src" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			terminalsStore.setRepoPath(id, null);

			addRepoWithBranch("/Gits/gate-os", "trunk");
			reconcile();

			expect(terminalsStore.get(id)?.repoPath).toBe("/Gits/gate-os");
			expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
				repoPath: "/Gits/gate-os",
				branchName: "trunk",
			});
			expect(repositoriesStore.get("/Gits/alpha")?.branches.main.terminals).not.toContain(id);
		});
	});

	it("leaves a still-unclaimed terminal parked rather than making it invisible", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			const id = terminalsStore.add(makeTerminal({ cwd: "/somewhere/else" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			terminalsStore.setRepoPath(id, null);

			reconcile();

			expect(repositoriesStore.findOwnerForTerminal(id)?.repoPath).toBe("/Gits/alpha");
			expect(terminalsStore.get(id)?.repoPath).toBeNull();
		});
	});

	it("does not move a terminal that is already placed correctly", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha/src" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			terminalsStore.setRepoPath(id, "/Gits/alpha");

			reconcile();

			expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
				repoPath: "/Gits/alpha",
				branchName: "main",
			});
			expect(repositoriesStore.get("/Gits/alpha")?.branches.main.terminals).toEqual([id]);
		});
	});

	it("repairs a correct placement whose repoPath record was never written", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha/src" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			// Placement right, record still null — the state a parked tab is left in
			// when the active repo happened to be the correct one all along.
			terminalsStore.setRepoPath(id, null);

			reconcile();

			expect(terminalsStore.get(id)?.repoPath).toBe("/Gits/alpha");
		});
	});

	it("sends a terminal inside a linked worktree to that worktree's branch", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			repositoriesStore.setBranch("/Gits/alpha", "feature-x", {
				worktreePath: "/Gits/alpha__wt/feature-x",
			});
			const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha__wt/feature-x/src" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			terminalsStore.setRepoPath(id, "/Gits/alpha");

			reconcile();

			expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
				repoPath: "/Gits/alpha",
				branchName: "feature-x",
			});
		});
	});

	it("ignores terminals with no cwd", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			const id = terminalsStore.add(makeTerminal({ cwd: null }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);

			reconcile();

			expect(repositoriesStore.findOwnerForTerminal(id)?.branchName).toBe("main");
		});
	});

	it("re-homes a terminal whose recorded owner no longer matches its cwd", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			addRepoWithBranch("/Gits/beta", "trunk");
			const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha/src" }));
			repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
			terminalsStore.setRepoPath(id, "/Gits/alpha");

			// A direct call still trusts the cwd — that is what repairs a placement
			// gone stale. A cd does NOT reach here; see reclaimParkedTerminal.
			terminalsStore.update(id, { cwd: "/Gits/beta/src" });
			reconcile(id);

			expect(terminalsStore.get(id)?.repoPath).toBe("/Gits/beta");
			expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
				repoPath: "/Gits/beta",
				branchName: "trunk",
			});
			// No stale id left behind in the repo it came from.
			expect(repositoriesStore.get("/Gits/alpha")?.branches.main.terminals).not.toContain(id);
		});
	});

	it("reconciles only the named terminal when given an id", () => {
		testInScope(() => {
			addRepoWithBranch("/Gits/alpha", "main");
			addRepoWithBranch("/Gits/beta", "trunk");
			// Both are misplaced, but a cd in one terminal is no reason to walk every
			// other terminal against every repo — that runs on each OSC 7.
			const moved = terminalsStore.add(makeTerminal({ cwd: "/Gits/beta/src" }));
			const untouched = terminalsStore.add(makeTerminal({ cwd: "/Gits/beta/lib" }));
			for (const id of [moved, untouched]) {
				repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
				terminalsStore.setRepoPath(id, "/Gits/alpha");
			}

			reconcile(moved);

			expect(repositoriesStore.findOwnerForTerminal(moved)?.repoPath).toBe("/Gits/beta");
			expect(repositoriesStore.findOwnerForTerminal(untouched)?.repoPath).toBe("/Gits/alpha");
		});
	});

	// What a cd is allowed to change. Re-homing an owned tab here moved it out
	// from under the user: the sidebar stayed on the old repo and the tab bar
	// filters on that, so the tab left the strip while the pane — which keys on
	// activeId alone — kept drawing it under a repo nobody had selected.
	describe("reclaimParkedTerminal", () => {
		it("leaves an owned terminal in its repo when the shell cds into another one", () => {
			testInScope(() => {
				addRepoWithBranch("/Gits/alpha", "main");
				addRepoWithBranch("/Gits/beta", "trunk");
				const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha/src" }));
				repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
				terminalsStore.setRepoPath(id, "/Gits/alpha");

				terminalsStore.update(id, { cwd: "/Gits/beta/src" });
				reclaimParked(id);

				expect(terminalsStore.get(id)?.repoPath).toBe("/Gits/alpha");
				expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
					repoPath: "/Gits/alpha",
					branchName: "main",
				});
				// Still listed where the user opened it, so the tab stays in the strip.
				expect(repositoriesStore.get("/Gits/alpha")?.branches.main.terminals).toContain(id);
			});
		});

		it("sends a parked terminal home when it cds into a repo we know", () => {
			testInScope(() => {
				addRepoWithBranch("/Gits/alpha", "main");
				addRepoWithBranch("/Gits/beta", "trunk");
				// No registered repo claimed its cwd, so it was parked in the active
				// repo and the null repoPath records that the placement is a guess.
				const id = terminalsStore.add(makeTerminal({ cwd: "/somewhere/else" }));
				repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
				terminalsStore.setRepoPath(id, null);

				terminalsStore.update(id, { cwd: "/Gits/beta/src" });
				reclaimParked(id);

				expect(terminalsStore.get(id)?.repoPath).toBe("/Gits/beta");
				expect(repositoriesStore.findOwnerForTerminal(id)?.repoPath).toBe("/Gits/beta");
			});
		});

		it("leaves a parked terminal parked when it cds somewhere still unclaimed", () => {
			testInScope(() => {
				addRepoWithBranch("/Gits/alpha", "main");
				const id = terminalsStore.add(makeTerminal({ cwd: "/somewhere/else" }));
				repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
				terminalsStore.setRepoPath(id, null);

				terminalsStore.update(id, { cwd: "/still/nowhere" });
				reclaimParked(id);

				expect(terminalsStore.get(id)?.repoPath).toBeNull();
				// Moving it nowhere would only make it invisible.
				expect(repositoriesStore.get("/Gits/alpha")?.branches.main.terminals).toContain(id);
			});
		});

		it("keeps an owned terminal put even when its own repo gains a matching worktree", () => {
			testInScope(() => {
				addRepoWithBranch("/Gits/alpha", "main");
				repositoriesStore.setBranch("/Gits/alpha", "feature", { worktreePath: "/Gits/alpha-feature" });
				const id = terminalsStore.add(makeTerminal({ cwd: "/Gits/alpha/src" }));
				repositoriesStore.addTerminalToBranch("/Gits/alpha", "main", id);
				terminalsStore.setRepoPath(id, "/Gits/alpha");

				// Same repo, other worktree — still navigation, still not a re-home.
				terminalsStore.update(id, { cwd: "/Gits/alpha-feature/src" });
				reclaimParked(id);

				expect(repositoriesStore.findOwnerForTerminal(id)).toEqual({
					repoPath: "/Gits/alpha",
					branchName: "main",
				});
			});
		});
	});
});
