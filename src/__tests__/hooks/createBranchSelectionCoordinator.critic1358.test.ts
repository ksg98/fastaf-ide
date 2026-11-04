import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const saved = (over: Record<string, unknown>) => ({
	name: "tab",
	cwd: "/Gits/alpha",
	fontSize: 14,
	agentType: null,
	agentSessionId: null,
	tuicSession: null,
	agentLaunchCommand: null,
	alias: null,
	...over,
});

describe("branch restore with suspended tabs (critic 1358)", () => {
	let createBranchSelectionCoordinator: typeof import("../../hooks/git/createBranchSelectionCoordinator").createBranchSelectionCoordinator;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		createBranchSelectionCoordinator = (await import("../../hooks/git/createBranchSelectionCoordinator"))
			.createBranchSelectionCoordinator;
		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		repositoriesStore._testSetHydrated(true);
	});
	afterEach(async () => {
		await vi.runAllTimersAsync();
		vi.useRealTimers();
		repositoriesStore._testCancelPendingSave();
	});

	async function restore(savedTerminals: unknown[]) {
		repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
		repositoriesStore.setWorkspace("/Gits/alpha", "main", {
			worktreePath: "/Gits/alpha",
			savedTerminals: savedTerminals as never,
		});
		repositoriesStore.setActiveWorkspace("/Gits/alpha", "main");
		await createBranchSelectionCoordinator({
			repo: { getDiffStats: async () => ({ additions: 0, deletions: 0 }) },
			pty: { canSpawn: async () => true },
			setStatusInfo: () => {},
			getDefaultFontSize: () => 14,
		}).handleBranchSelectInner("/Gits/alpha", "main");
		return terminalsStore.getIds().map((id) => terminalsStore.get(id)!);
	}

	// Catches: a file saved before this feature (no `suspended` key) is read as suspended, or the
	// plain-shell filter now keeps unsuspended shells.
	it("restores an old record without the flag as before: agent live, plain shell dropped", () =>
		testInScope(async () => {
			const tabs = await restore([saved({ name: "agent", agentType: "claude" }), saved({ name: "shell" })]);
			expect(tabs.map((t) => t.name)).toEqual(["agent"]);
			expect(tabs[0].suspended).toBe(false);
		}));

	// Catches: `suspended: false` explicitly saved on a plain shell is treated as truthy-present.
	it("drops a plain shell saved with suspended=false", () =>
		testInScope(async () => {
			const tabs = await restore([saved({ name: "shell", suspended: false })]);
			// All-plain-shell snapshots fall through to a fresh terminal; none is the restored record.
			expect(tabs.map((t) => t.name)).not.toContain("shell");
			expect(tabs.some((t) => t.suspended)).toBe(false);
		}));

	// Catches: a suspended plain shell is dropped like an unsuspended one, or comes back running.
	it("keeps a suspended plain shell without a PTY", () =>
		testInScope(async () => {
			const tabs = await restore([saved({ name: "kept", suspended: true })]);
			expect(tabs).toHaveLength(1);
			expect(tabs[0]).toMatchObject({ name: "kept", suspended: true, sessionId: null, pendingResumeCommand: null });
		}));
});
