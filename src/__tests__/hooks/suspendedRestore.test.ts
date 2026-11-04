import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
const mockVerifyResume = vi.fn();

describe("restoring suspended tabs", () => {
	let createBranchSelectionCoordinator: typeof import("../../hooks/git/createBranchSelectionCoordinator").createBranchSelectionCoordinator;
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		mockVerifyResume.mockReset().mockResolvedValue("claude --resume agent-uuid");
		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
		vi.doMock("../../utils/agentSession", () => ({
			verifyAndBuildResumeCommand: (...args: unknown[]) => mockVerifyResume(...args),
		}));
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
		agentType: null,
		agentSessionId: null,
		tuicSession: "tab-uuid",
		agentLaunchCommand: null,
		alias: null,
		...over,
	});

	// A restart restores only agent tabs; a suspended plain shell was dropped by that
	// filter, so the user lost a tab they had parked on purpose.
	it("restores a suspended plain shell tab, still suspended", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", {
				worktreePath: "/Gits/alpha",
				savedTerminals: [saved({ suspended: true })],
			});

			await coordinator().handleBranchSelectInner("/Gits/alpha", "main");

			const tabs = terminalsStore.getIds().map((id) => terminalsStore.get(id));
			expect(tabs).toHaveLength(1);
			expect(tabs[0]).toMatchObject({ suspended: true, sessionId: null, cwd: "/Gits/alpha" });
		});
	});

	// A restore that built the resume banner for a suspended agent tab would show two
	// resume prompts (banner and suspended notice) and let the banner start the agent
	// inside a tab that has no PTY.
	it("restores a suspended agent tab without a resume banner", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", {
				worktreePath: "/Gits/alpha",
				savedTerminals: [saved({ agentType: "claude", agentSessionId: "agent-uuid", suspended: true })],
			});

			await coordinator().handleBranchSelectInner("/Gits/alpha", "main");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [tab] = terminalsStore.getIds().map((id) => terminalsStore.get(id));
			expect(tab).toMatchObject({ suspended: true, agentType: "claude", agentSessionId: "agent-uuid" });
			expect(tab?.pendingResumeCommand).toBeNull();
			expect(mockVerifyResume).not.toHaveBeenCalled();
		});
	});

	// Regression guard for the existing restart path the suspend feature reuses.
	it("still builds the resume banner for a restored agent tab that was not suspended", async () => {
		await testInScope(async () => {
			repositoriesStore.add({ path: "/Gits/alpha", displayName: "alpha" });
			repositoriesStore.setWorkspace("/Gits/alpha", "main", {
				worktreePath: "/Gits/alpha",
				savedTerminals: [saved({ agentType: "claude", agentSessionId: "agent-uuid" })],
			});

			await coordinator().handleBranchSelectInner("/Gits/alpha", "main");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const [tab] = terminalsStore.getIds().map((id) => terminalsStore.get(id));
			expect(tab).toMatchObject({ suspended: false, pendingResumeCommand: "claude --resume agent-uuid" });
		});
	});
});
