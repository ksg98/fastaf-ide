import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen, mockUnlisten } = vi.hoisted(() => ({
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockListen: vi.fn().mockResolvedValue(vi.fn()),
	mockUnlisten: vi.fn(),
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
	listen: mockListen,
}));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { handleAgentExitCompletion } from "../../components/Terminal/agentExitCompletion";
import { useTerminalCompletionNotifications } from "../../hooks/useTerminalCompletionNotifications";
import { activityStore } from "../../stores/activityStore";
import { notificationsStore } from "../../stores/notifications";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

type SystemWakeHandler = (event: { payload: number }) => void;

const addTerminal = (agentType: "claude" | null = null) =>
	terminalsStore.add({
		sessionId: null,
		fontSize: 14,
		name: agentType ? "Claude" : "Shell",
		cwd: "/repo",
		awaitingInput: null,
		agentType,
	});

const runBusyCycle = async (id: string, durationMs = 6_000) => {
	terminalsStore.update(id, { shellState: "busy" });
	await vi.advanceTimersByTimeAsync(durationMs);
	terminalsStore.update(id, { shellState: "idle" });
	await vi.advanceTimersByTimeAsync(2_000);
};

const resetStores = () => {
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
	activityStore.clearAll();
};

describe("useTerminalCompletionNotifications", () => {
	let dispose: (() => void) | undefined;
	let systemWakeHandler: SystemWakeHandler | undefined;
	let playCompletion: ReturnType<typeof vi.spyOn>;
	let addActivityItem: ReturnType<typeof vi.spyOn>;
	const navigateToTerminal = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		resetStores();
		mockInvoke.mockClear();
		mockListen.mockReset().mockImplementation((event: string, handler: SystemWakeHandler) => {
			if (event === "system-wake") systemWakeHandler = handler;
			return Promise.resolve(mockUnlisten);
		});
		mockUnlisten.mockClear();
		navigateToTerminal.mockClear();
		playCompletion = vi.spyOn(notificationsStore, "playCompletion").mockResolvedValue(undefined);
		addActivityItem = vi.spyOn(activityStore, "addItem");
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useTerminalCompletionNotifications({ navigateToTerminal });
		});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		playCompletion.mockRestore();
		addActivityItem.mockRestore();
		resetStores();
		vi.useRealTimers();
	});

	it("notifies after a background shell completes meaningful work", async () => {
		const id = addTerminal();
		terminalsStore.setActive(null);

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(800);

		expect(playCompletion).toHaveBeenCalledWith(id);
		expect(terminalsStore.get(id)).toMatchObject({ activity: true, unseen: true, completionNotified: true });
		expect(addActivityItem).toHaveBeenCalledWith(expect.objectContaining({ id: `terminal-done-${id}` }));

		const activity = addActivityItem.mock.calls[0][0];
		activity.onClick?.();
		expect(navigateToTerminal).toHaveBeenCalledWith(id);
	});

	it("opens a fresh notification cycle when the terminal becomes busy again", async () => {
		const id = addTerminal("claude");
		terminalsStore.setActive(null);

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(terminalsStore.get(id)?.completionNotified).toBe(true);

		terminalsStore.update(id, { shellState: "busy" });
		expect(terminalsStore.get(id)?.completionNotified).toBe(false);
	});

	it("notifies exactly once when the agent exits before its deferred completion", async () => {
		const id = addTerminal("claude");
		terminalsStore.setActive(null);

		await runBusyCycle(id);
		expect(handleAgentExitCompletion(id)).toBe(true);
		terminalsStore.update(id, { shellState: "exited", agentType: null });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(playCompletion).toHaveBeenCalledTimes(1);
	});

	it("does not notify again when the agent exits after deferred completion", async () => {
		const id = addTerminal("claude");
		terminalsStore.setActive(null);

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(terminalsStore.get(id)?.completionNotified).toBe(true);

		expect(handleAgentExitCompletion(id)).toBe(false);
		expect(playCompletion).toHaveBeenCalledTimes(1);
	});

	it("keeps a remote exit fallback silent while still claiming the cycle", async () => {
		const id = addTerminal("claude");
		terminalsStore.update(id, { isExternallyCreated: true });
		terminalsStore.setActive(null);
		notificationsStore.setSilenceRemoteCompletions(true);

		expect(handleAgentExitCompletion(id)).toBe(true);
		expect(terminalsStore.get(id)?.completionNotified).toBe(true);
		expect(playCompletion).not.toHaveBeenCalled();
		notificationsStore.setSilenceRemoteCompletions(false);
	});

	it("suppresses completion for the active terminal", async () => {
		const id = addTerminal();
		terminalsStore.setActive(id);

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(playCompletion).not.toHaveBeenCalled();
	});

	it("defers agent completion and cancels it when the agent resumes", async () => {
		const id = addTerminal("claude");
		terminalsStore.setActive(null);

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(5_000);
		terminalsStore.update(id, { shellState: "busy" });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(playCompletion).not.toHaveBeenCalled();
	});

	it("suppresses completions during the system-wake grace window", async () => {
		const id = addTerminal();
		terminalsStore.setActive(null);
		await Promise.resolve();
		systemWakeHandler?.({ payload: Date.now() });

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(playCompletion).not.toHaveBeenCalled();
	});

	it("unsubscribes from system and terminal events when disposed", async () => {
		await Promise.resolve();
		dispose?.();
		dispose = undefined;
		const id = addTerminal();

		await runBusyCycle(id);
		await vi.advanceTimersByTimeAsync(10_000);

		expect(mockUnlisten).toHaveBeenCalledOnce();
		expect(playCompletion).not.toHaveBeenCalled();
	});
});
