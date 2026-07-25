import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockConversation,
	mockGithub,
	mockInvoke,
	mockListen,
	mockLongPress,
	mockNotifications,
	mockPlatform,
	mockSettings,
	mockTerminals,
	mockToasts,
	mockUi,
	mockWatcher,
} = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	mockConversation: { startAgent: vi.fn() },
	mockGithub: { stopPolling: vi.fn() },
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockListen: vi.fn(),
	mockLongPress: vi.fn(),
	mockNotifications: { clearBadge: vi.fn() },
	mockPlatform: { active: vi.fn(), release: vi.fn() },
	mockSettings: {
		state: { preventSleepWhenBusy: true },
		isAiChatEnabled: vi.fn(() => true),
	},
	mockTerminals: {
		isAnyBusy: vi.fn(() => true),
		onShellExit: vi.fn(),
	},
	mockToasts: { add: vi.fn() },
	mockUi: { setAiChatPanelVisible: vi.fn() },
	mockWatcher: { deps: {}, handle: vi.fn(), createDeps: vi.fn(() => ({})) },
}));

vi.mock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));
vi.mock("../../platform", () => ({
	isQuickSwitcherActive: mockPlatform.active,
	isQuickSwitcherRelease: mockPlatform.release,
}));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../stores/conversationStore", () => ({ conversationStore: mockConversation }));
vi.mock("../../stores/dictation", () => ({
	dictationStore: { state: { enabled: true, hotkey: "Space", capturingHotkey: false, longPressMs: 300 } },
}));
vi.mock("../../stores/github", () => ({ githubStore: mockGithub }));
vi.mock("../../stores/notifications", () => ({ notificationsStore: mockNotifications }));
vi.mock("../../stores/settings", () => ({ settingsStore: mockSettings }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockTerminals }));
vi.mock("../../stores/toasts", () => ({ toastsStore: mockToasts }));
vi.mock("../../stores/ui", () => ({ uiStore: mockUi }));
vi.mock("../../stores/watcherFire", () => ({
	handleWatcherFire: mockWatcher.handle,
	watcherFireDeps: mockWatcher.createDeps,
}));
vi.mock("../../transport", () => ({ isTauri: () => true }));
vi.mock("../../utils/switchToTerminalBySession", () => ({ switchToTerminalBySession: vi.fn() }));
vi.mock("../../hooks/useLongPressHotkey", () => ({ createLongPressHandlerFromHotkey: mockLongPress }));

import { useAutomationEventBridges } from "../../hooks/useAutomationEventBridges";
import { useDictationHotkey } from "../../hooks/useDictationHotkey";
import { useQuickSwitcherVisibility } from "../../hooks/useQuickSwitcherVisibility";
import { useSystemLifecycle } from "../../hooks/useSystemLifecycle";
import { useTerminalShellExit } from "../../hooks/useTerminalShellExit";

describe("application runtime boundaries", () => {
	let dispose: (() => void) | undefined;
	const unlisteners: Array<ReturnType<typeof vi.fn>> = [];

	beforeEach(() => {
		handlers.clear();
		unlisteners.length = 0;
		mockListen.mockReset().mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
			handlers.set(event, handler);
			const unlisten = vi.fn();
			unlisteners.push(unlisten);
			return Promise.resolve(unlisten);
		});
		mockSettings.isAiChatEnabled.mockReturnValue(true);
		mockTerminals.isAnyBusy.mockReturnValue(true);
		mockInvoke.mockClear();
		mockToasts.add.mockClear();
		mockConversation.startAgent.mockClear();
		mockUi.setAiChatPanelVisible.mockClear();
		mockWatcher.handle.mockClear();
		mockGithub.stopPolling.mockClear();
		mockNotifications.clearBadge.mockClear();
		mockPlatform.active.mockReset().mockImplementation((event: KeyboardEvent) => event.key === "Meta");
		mockPlatform.release.mockReset().mockImplementation((event: KeyboardEvent) => event.key === "Meta");
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("routes AI suggestions and watcher events and disposes both listeners", async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useAutomationEventBridges({ executeSmartPrompt: vi.fn().mockResolvedValue(undefined) });
		});
		await Promise.resolve();

		handlers.get("ai-suggestion")?.({
			payload: { session_id: "session-1", trigger_reason: "CI failed", proposed_goal: "Fix CI" },
		});
		const toastOptions = mockToasts.add.mock.calls[0][4];
		toastOptions.onClick();
		handlers.get("watcher-fire")?.({ payload: { watcher_id: "watcher-1" } });

		expect(mockUi.setAiChatPanelVisible).toHaveBeenCalledWith(true);
		expect(mockConversation.startAgent).toHaveBeenCalledWith("session-1", "Fix CI");
		expect(mockWatcher.handle).toHaveBeenCalledOnce();
		dispose?.();
		dispose = undefined;
		expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
	});

	it("keeps disabled AI suggestions from starting an agent", async () => {
		mockSettings.isAiChatEnabled.mockReturnValue(false);
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useAutomationEventBridges({ executeSmartPrompt: vi.fn().mockResolvedValue(undefined) });
		});
		await Promise.resolve();
		handlers.get("ai-suggestion")?.({
			payload: { session_id: "session-1", trigger_reason: "Failed", proposed_goal: "Fix" },
		});
		mockToasts.add.mock.calls[0][4].onClick();

		expect(mockConversation.startAgent).not.toHaveBeenCalled();
		expect(mockToasts.add).toHaveBeenCalledTimes(2);
	});

	it("owns shell-exit subscription cleanup", () => {
		const unsubscribe = vi.fn();
		let shellExit: ((id: string) => void) | undefined;
		mockTerminals.onShellExit.mockImplementation((handler: (id: string) => void) => {
			shellExit = handler;
			return unsubscribe;
		});
		const closeTerminal = vi.fn();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useTerminalShellExit(closeTerminal);
		});

		shellExit?.("term-1");
		expect(closeTerminal).toHaveBeenCalledWith("term-1", true);
		dispose?.();
		dispose = undefined;
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("tracks quick-switcher visibility and removes DOM listeners", () => {
		const setVisible = vi.fn();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useQuickSwitcherVisibility(setVisible);
		});

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
		document.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
		expect(setVisible).toHaveBeenNthCalledWith(1, true);
		expect(setVisible).toHaveBeenNthCalledWith(2, false);
		dispose?.();
		dispose = undefined;
		setVisible.mockClear();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta" }));
		expect(setVisible).not.toHaveBeenCalled();
	});

	it("starts sleep prevention, clears focus badges, and stops polling on cleanup", () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useSystemLifecycle();
		});

		expect(mockInvoke).toHaveBeenCalledWith("block_sleep");
		window.dispatchEvent(new Event("focus"));
		expect(mockNotifications.clearBadge).toHaveBeenCalledOnce();
		dispose?.();
		dispose = undefined;
		expect(mockGithub.stopPolling).toHaveBeenCalledOnce();
	});

	it("owns regular dictation key handlers and cleanup", () => {
		const handler = { handleEvent: vi.fn(() => true), cleanup: vi.fn() };
		mockLongPress.mockReturnValue(handler);
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useDictationHotkey({ onStart: vi.fn(), onStop: vi.fn() });
		});

		window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
		window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
		expect(handler.handleEvent).toHaveBeenCalledTimes(2);
		dispose?.();
		dispose = undefined;
		expect(handler.cleanup).toHaveBeenCalledOnce();
		handler.handleEvent.mockClear();
		window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
		expect(handler.handleEvent).not.toHaveBeenCalled();
	});
});
