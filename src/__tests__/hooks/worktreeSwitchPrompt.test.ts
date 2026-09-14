import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal, testInScopeAsync } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
const mockListen = vi.fn().mockResolvedValue(vi.fn());

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
	listen: mockListen,
}));

const REPO = "/repo";
const WORKTREE = "/repo__wt/feature";
const BRANCH = "feature";

describe("switchToCreatedWorktree", () => {
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;
	let switchToCreatedWorktree: typeof import("../../hooks/useWorktreeSwitchPrompt").switchToCreatedWorktree;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		mockListen.mockReset().mockResolvedValue(vi.fn());
		localStorage.clear();
		vi.doMock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));

		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		repositoriesStore._testSetHydrated(true);
		switchToCreatedWorktree = (await import("../../hooks/useWorktreeSwitchPrompt")).switchToCreatedWorktree;
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
		terminalsStore._testCancelPendingTimers();
		vi.useRealTimers();
	});

	function seedActiveTerminal(agentType: "codex" | null): string {
		repositoriesStore.add({ path: REPO, displayName: "repo" });
		repositoriesStore.setBranch(REPO, "main", { worktreePath: REPO, isMain: true });
		repositoriesStore.setBranch(REPO, BRANCH, { worktreePath: WORKTREE });
		const terminalId = terminalsStore.add(makeTerminal({ sessionId: "session-main", cwd: REPO, agentType }));
		repositoriesStore.addTerminalToBranch(REPO, "main", terminalId);
		terminalsStore.setActive(terminalId);
		mockInvoke.mockClear();
		return terminalId;
	}

	it("opens the worktree without moving or interrupting a running agent", async () => {
		await testInScopeAsync(async () => {
			const terminalId = seedActiveTerminal("codex");
			const handleBranchSelect = vi.fn().mockResolvedValue(undefined);

			await switchToCreatedWorktree({ handleBranchSelect, closeTerminalsForBranch: vi.fn() }, REPO, BRANCH, WORKTREE);

			expect(handleBranchSelect).toHaveBeenCalledWith(REPO, BRANCH);
			expect(repositoriesStore.get(REPO)!.branches.main.terminals).toContain(terminalId);
			expect(repositoriesStore.get(REPO)!.branches[BRANCH].terminals).not.toContain(terminalId);
			expect(mockInvoke).not.toHaveBeenCalled();
		});
	});

	it("keeps moving a plain shell into the worktree", async () => {
		await testInScopeAsync(async () => {
			const terminalId = seedActiveTerminal(null);
			const handleBranchSelect = vi.fn().mockResolvedValue(undefined);

			await switchToCreatedWorktree({ handleBranchSelect, closeTerminalsForBranch: vi.fn() }, REPO, BRANCH, WORKTREE);

			expect(handleBranchSelect).toHaveBeenCalledWith(REPO, BRANCH);
			expect(repositoriesStore.get(REPO)!.branches.main.terminals).not.toContain(terminalId);
			expect(repositoriesStore.get(REPO)!.branches[BRANCH].terminals).toContain(terminalId);
			expect(mockInvoke).toHaveBeenCalledWith("write_pty", {
				sessionId: "session-main",
				data: `cd ${WORKTREE}\n`,
			});
		});
	});

	// The decision is made at click time, not when the worktree was created: the
	// toast outlives the event, so the tab that was active then may not be the tab
	// that is active now.
	it("re-reads the active terminal at call time", async () => {
		await testInScopeAsync(async () => {
			const shellId = seedActiveTerminal(null);
			const agentId = terminalsStore.add(makeTerminal({ sessionId: "session-agent", cwd: REPO, agentType: "codex" }));
			repositoriesStore.addTerminalToBranch(REPO, "main", agentId);
			terminalsStore.setActive(agentId);
			mockInvoke.mockClear();
			const handleBranchSelect = vi.fn().mockResolvedValue(undefined);

			await switchToCreatedWorktree({ handleBranchSelect, closeTerminalsForBranch: vi.fn() }, REPO, BRANCH, WORKTREE);

			// The agent is the active tab now, so nothing moves and no cd is written —
			// even though a movable shell was active when the worktree was created.
			expect(repositoriesStore.get(REPO)!.branches.main.terminals).toContain(shellId);
			expect(repositoriesStore.get(REPO)!.branches[BRANCH].terminals).not.toContain(agentId);
			expect(mockInvoke).not.toHaveBeenCalled();
		});
	});
});

describe("useWorktreeSwitchPrompt — worktree-created", () => {
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let terminalsStore: typeof import("../../stores/terminals").terminalsStore;
	let toastsStore: typeof import("../../stores/toasts").toastsStore;
	let activityStore: typeof import("../../stores/activityStore").activityStore;
	let useWorktreeSwitchPrompt: typeof import("../../hooks/useWorktreeSwitchPrompt").useWorktreeSwitchPrompt;
	let handlers: Map<string, (event: { payload: unknown }) => void>;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		handlers = new Map();
		mockListen.mockReset().mockImplementation((name: string, cb: (event: { payload: unknown }) => void) => {
			handlers.set(name, cb);
			return Promise.resolve(vi.fn());
		});
		localStorage.clear();
		vi.doMock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));

		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		terminalsStore = (await import("../../stores/terminals")).terminalsStore;
		toastsStore = (await import("../../stores/toasts")).toastsStore;
		activityStore = (await import("../../stores/activityStore")).activityStore;
		repositoriesStore._testSetHydrated(true);
		useWorktreeSwitchPrompt = (await import("../../hooks/useWorktreeSwitchPrompt")).useWorktreeSwitchPrompt;
	});

	afterEach(() => {
		repositoriesStore._testCancelPendingSave();
		terminalsStore._testCancelPendingTimers();
		vi.useRealTimers();
	});

	async function emitCreated(handleBranchSelect = vi.fn().mockResolvedValue(undefined)) {
		repositoriesStore.add({ path: REPO, displayName: "repo" });
		repositoriesStore.setBranch(REPO, "main", { worktreePath: REPO, isMain: true });
		useWorktreeSwitchPrompt({ handleBranchSelect, closeTerminalsForBranch: vi.fn() });
		await Promise.resolve();
		handlers.get("worktree-created")?.({
			payload: { repo_path: REPO, branch: BRANCH, worktree_path: WORKTREE },
		});
		return handleBranchSelect;
	}

	it("offers the switch as a toast, not as a blocking dialog", async () => {
		await testInScopeAsync(async () => {
			const handleBranchSelect = await emitCreated();

			const toast = toastsStore.toasts.find((t) => t.title === `Worktree "${BRANCH}" created`);
			expect(toast).toBeDefined();
			expect(toast!.message).toBe("repo__wt/feature");
			expect(toast!.repoPath).toBe(REPO);
			expect(toast!.action?.label).toBe("Switch");
			// Nothing has moved yet — the offer is waiting on the user, and the user
			// is free to ignore it forever.
			expect(handleBranchSelect).not.toHaveBeenCalled();
		});
	});

	it("registers the worktree in the sidebar whether or not the offer is taken", async () => {
		await testInScopeAsync(async () => {
			await emitCreated();

			expect(repositoriesStore.get(REPO)!.branches[BRANCH]?.worktreePath).toBe(WORKTREE);
			expect(activityStore.getForSection("worktrees").some((i) => i.title === `Worktree: ${BRANCH}`)).toBe(true);
		});
	});

	it("switches only once the toast action is clicked", async () => {
		await testInScopeAsync(async () => {
			const handleBranchSelect = await emitCreated();

			const toast = toastsStore.toasts.find((t) => t.title === `Worktree "${BRANCH}" created`);
			toast!.action!.onClick();
			await Promise.resolve();

			expect(handleBranchSelect).toHaveBeenCalledWith(REPO, BRANCH);
		});
	});

	it("keeps the offer reachable from the bell after the toast is gone", async () => {
		await testInScopeAsync(async () => {
			const handleBranchSelect = await emitCreated();

			const item = activityStore.getForSection("worktrees").find((i) => i.title === `Worktree: ${BRANCH}`);
			expect(item?.onClick).toBeTypeOf("function");
			item!.onClick!();
			await Promise.resolve();

			expect(handleBranchSelect).toHaveBeenCalledWith(REPO, BRANCH);
		});
	});
});
