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

import { useIdleTriage } from "../../hooks/useIdleTriage";
import { useTerminalCompletionNotifications } from "../../hooks/useTerminalCompletionNotifications";
import { activityStore } from "../../stores/activityStore";
import { aiTriageStore } from "../../stores/aiTriageStore";
import { notificationsStore } from "../../stores/notifications";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";
import { uiStore } from "../../stores/ui";

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
	uiStore.setAiTriagePanelVisible(false);
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
		expect(terminalsStore.get(id)).toMatchObject({ activity: true, unseen: true });
		expect(addActivityItem).toHaveBeenCalledWith(expect.objectContaining({ id: `terminal-done-${id}` }));

		const activity = addActivityItem.mock.calls[0][0];
		activity.onClick?.();
		expect(navigateToTerminal).toHaveBeenCalledWith(id);
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

describe("useIdleTriage", () => {
	let dispose: (() => void) | undefined;
	let runTriage: ReturnType<typeof vi.spyOn>;
	let triageEnabled: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		resetStores();
		runTriage = vi.spyOn(aiTriageStore, "runTriage").mockImplementation(() => {});
		triageEnabled = vi.spyOn(settingsStore, "isAiTriageEnabled").mockReturnValue(false);
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useIdleTriage();
		});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		runTriage.mockRestore();
		triageEnabled.mockRestore();
		resetStores();
		vi.useRealTimers();
	});

	const configureRepo = (terminalId: string) => {
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setBranch("/repo", "main", { worktreePath: "/repo" });
		repositoriesStore.addTerminalToBranch("/repo", "main", terminalId);
	};

	it("runs triage for an agent repository when the visible feature is enabled", async () => {
		const id = addTerminal("claude");
		configureRepo(id);
		triageEnabled.mockReturnValue(true);
		uiStore.setAiTriagePanelVisible(true);

		await runBusyCycle(id);

		expect(runTriage).toHaveBeenCalledWith("/repo");
	});

	it("does not run triage while its panel is hidden", async () => {
		const id = addTerminal("claude");
		configureRepo(id);
		triageEnabled.mockReturnValue(true);

		await runBusyCycle(id);

		expect(runTriage).not.toHaveBeenCalled();
	});

	it("does not run triage for a plain shell", async () => {
		const id = addTerminal();
		configureRepo(id);
		triageEnabled.mockReturnValue(true);
		uiStore.setAiTriagePanelVisible(true);

		await runBusyCycle(id);

		expect(runTriage).not.toHaveBeenCalled();
	});

	it("does not run triage below the meaningful-work threshold", async () => {
		const id = addTerminal("claude");
		configureRepo(id);
		triageEnabled.mockReturnValue(true);
		uiStore.setAiTriagePanelVisible(true);

		await runBusyCycle(id, 4_999);

		expect(runTriage).not.toHaveBeenCalled();
	});
});
