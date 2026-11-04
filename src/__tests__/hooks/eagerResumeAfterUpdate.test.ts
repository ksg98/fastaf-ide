import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const UPDATE_MARKER = "tuic.updateRestartAt";
const mockInvoke = vi.fn().mockResolvedValue(undefined);

/** A session id starting with "ok" exists on disk; any other id does not. */
const resolveResume = (_type: string, _cwd: string | null, _tab: unknown, sessionId?: string | null) => {
	const verified = !!sessionId?.startsWith("ok");
	return Promise.resolve({
		cmd: sessionId ? `claude --resume ${sessionId}` : "claude --continue",
		verified,
	});
};

describe("resuming agent tabs after an update restart", () => {
	let createBranchSelectionCoordinator: typeof import("../../hooks/git/createBranchSelectionCoordinator").createBranchSelectionCoordinator;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;
	let settingsStore: typeof import("../../stores/settings").settingsStore;

	/** Load the app modules as a freshly started process would see them. */
	async function boot(marker: string | null): Promise<void> {
		localStorage.clear();
		if (marker !== null) localStorage.setItem(UPDATE_MARKER, marker);
		vi.resetModules();
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		vi.doMock("../../utils/agentSession", () => ({
			verifyAndBuildResumeCommand: async (_t: string, _c: string | null, _s: unknown, id?: string | null) =>
				id ? `claude --resume ${id}` : null,
			resolveAgentResume: resolveResume,
		}));
		createBranchSelectionCoordinator = (await import("../../hooks/git/createBranchSelectionCoordinator"))
			.createBranchSelectionCoordinator;
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		settingsStore = (await import("../../stores/settings")).settingsStore;
		repositoriesStore._testSetHydrated(true);
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
		mockInvoke.mockReset().mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		repositoriesStore._testCancelPendingSave();
		localStorage.clear();
	});

	const coordinator = () =>
		createBranchSelectionCoordinator({
			repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
			pty: { canSpawn: async () => true },
			setStatusInfo: () => {},
			getDefaultFontSize: () => 14,
		});

	const saved = (over: Record<string, unknown>) => ({
		name: "tab",
		cwd: "/Gits/alpha",
		fontSize: 14,
		agentType: "claude",
		agentSessionId: null,
		tuicSession: null,
		agentLaunchCommand: null,
		alias: null,
		...over,
	});

	const tabsOf = (workspaceId: string) =>
		(repositoriesStore.get("/Gits/alpha")?.workspaces[workspaceId]?.terminals ?? []).map((id) =>
			terminalsStore.get(id),
		);

	function seedTwoBranches(mainTabs: unknown[], featTabs: unknown[]): void {
		repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
		repositoriesStore.setWorkspace("/Gits/alpha", "main", {
			worktreePath: "/Gits/alpha",
			savedTerminals: mainTabs as never,
		});
		repositoriesStore.setWorkspace("/Gits/alpha", "feat", {
			worktreePath: "/Gits/alpha-feat",
			branchName: "feat",
			savedTerminals: featTabs as never,
		});
	}

	// Catches: only the selected branch resumes — the agent on the other branch waits
	// for Boss to visit its tab.
	it("resumes a verified agent tab on every branch, not only the selected one", async () => {
		await boot(String(Date.now()));
		await testInScope(async () => {
			seedTwoBranches(
				[saved({ name: "main-agent", agentSessionId: "ok-main" })],
				[saved({ name: "feat-agent", cwd: "/Gits/alpha-feat", agentSessionId: "ok-feat" })],
			);

			const c = coordinator();
			await c.handleBranchSelectInner("/Gits/alpha", "main");
			await c.resumeAgentTabsAfterUpdate();

			expect(tabsOf("main").map((t) => t?.pendingInitCommand)).toEqual(["claude --resume ok-main"]);
			expect(tabsOf("feat").map((t) => t?.pendingInitCommand)).toEqual(["claude --resume ok-feat"]);
			expect(tabsOf("feat")[0]?.pendingResumeCommand).toBeNull();
			expect(repositoriesStore.get("/Gits/alpha")?.workspaces.feat.savedTerminals).toEqual([]);
		});
	});

	// Catches: the sweep creating terminals for a branch whose agent has no verified
	// session, turning the lazy path into an empty shell the user never asked for.
	it("leaves a branch with no verified agent session lazy", async () => {
		await boot(String(Date.now()));
		await testInScope(async () => {
			seedTwoBranches([], [saved({ cwd: "/Gits/alpha-feat", agentSessionId: null })]);

			await coordinator().resumeAgentTabsAfterUpdate();

			expect(terminalsStore.getIds()).toEqual([]);
			expect(repositoriesStore.get("/Gits/alpha")?.workspaces.feat.savedTerminals).toHaveLength(1);
		});
	});

	// Catches: an agent whose session id is missing on disk being typed a --resume that
	// fails; it must keep the click-to-resume banner of the lazy path.
	it("keeps the banner for an unverified tab that shares a branch with a verified one", async () => {
		await boot(String(Date.now()));
		await testInScope(async () => {
			seedTwoBranches(
				[],
				[
					saved({ name: "good", cwd: "/Gits/alpha-feat", agentSessionId: "ok-1" }),
					saved({ name: "gone", cwd: "/Gits/alpha-feat", agentSessionId: "stale-2" }),
				],
			);

			await coordinator().resumeAgentTabsAfterUpdate();

			const [good, gone] = tabsOf("feat");
			expect(good).toMatchObject({ pendingInitCommand: "claude --resume ok-1", pendingResumeCommand: null });
			expect(gone).toMatchObject({ pendingInitCommand: null, pendingResumeCommand: "claude --resume stale-2" });
		});
	});

	// Catches: the selected branch restoring through the click-to-resume banner after an
	// update, so its agents still wait for a click.
	it("resumes the selected branch automatically too", async () => {
		await boot(String(Date.now()));
		await testInScope(async () => {
			seedTwoBranches([saved({ agentSessionId: "ok-main" })], []);

			await coordinator().handleBranchSelectInner("/Gits/alpha", "main");

			expect(tabsOf("main")[0]).toMatchObject({
				pendingInitCommand: "claude --resume ok-main",
				pendingResumeCommand: null,
			});
		});
	});

	// Catches: eager resume on an ordinary restart (no update): every launch would
	// start all saved agents.
	it("does nothing when the restart was not caused by an update", async () => {
		await boot(null);
		await testInScope(async () => {
			seedTwoBranches([], [saved({ cwd: "/Gits/alpha-feat", agentSessionId: "ok-feat" })]);

			await coordinator().resumeAgentTabsAfterUpdate();

			expect(terminalsStore.getIds()).toEqual([]);
		});
	});

	// Catches: the setting being ignored.
	it("does nothing when eager resume is switched off", async () => {
		await boot(String(Date.now()));
		await testInScope(async () => {
			settingsStore.setEagerResumeAfterUpdate(false);
			seedTwoBranches([], [saved({ cwd: "/Gits/alpha-feat", agentSessionId: "ok-feat" })]);

			await coordinator().resumeAgentTabsAfterUpdate();

			expect(terminalsStore.getIds()).toEqual([]);
		});
	});

	// Catches: the marker surviving the boot that consumed it, so the next plain restart
	// resumes everything again.
	it("consumes the marker so a later restart is not eager", async () => {
		await boot(String(Date.now()));
		expect(localStorage.getItem(UPDATE_MARKER)).toBeNull();
	});
});
