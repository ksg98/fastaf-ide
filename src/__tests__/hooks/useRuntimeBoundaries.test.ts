import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGithub,
	mockInvoke,
	mockListen,
	mockLongPress,
	mockNotifications,
	mockPlatform,
	mockSettings,
	mockTerminals,
} = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	mockGithub: { stopPolling: vi.fn() },
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockListen: vi.fn(),
	mockLongPress: vi.fn(),
	mockNotifications: { clearBadge: vi.fn() },
	mockPlatform: { active: vi.fn(), release: vi.fn() },
	mockSettings: { state: { preventSleepWhenBusy: true } },
	mockTerminals: {
		isAnyBusy: vi.fn(() => true),
		onShellExit: vi.fn(),
	},
}));

vi.mock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));
vi.mock("../../platform", () => ({
	isMacOS: () => true,
	isQuickSwitcherActive: mockPlatform.active,
	isQuickSwitcherRelease: mockPlatform.release,
}));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../stores/dictation", () => ({
	dictationStore: { state: { enabled: true, hotkey: "Space", capturingHotkey: false, longPressMs: 300 } },
}));
vi.mock("../../stores/github", () => ({ githubStore: mockGithub }));
vi.mock("../../stores/notifications", () => ({ notificationsStore: mockNotifications }));
vi.mock("../../stores/settings", () => ({ settingsStore: mockSettings }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockTerminals }));
vi.mock("../../transport", () => ({ isTauri: () => true }));
vi.mock("../../hooks/useLongPressHotkey", () => ({ createLongPressHandlerFromHotkey: mockLongPress }));

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
		mockTerminals.isAnyBusy.mockReturnValue(true);
		mockInvoke.mockClear();
		mockGithub.stopPolling.mockClear();
		mockNotifications.clearBadge.mockClear();
		mockPlatform.active.mockReset().mockImplementation((event: KeyboardEvent) => event.key === "Meta");
		mockPlatform.release.mockReset().mockImplementation((event: KeyboardEvent) => event.key === "Meta");
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
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

	// Catches: a busy WebView takes sleep ownership back from the backend.
	it("leaves sleep ownership to the backend, clears focus badges, and stops polling on cleanup", () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useSystemLifecycle();
		});

		window.dispatchEvent(new Event("focus"));
		expect(mockNotifications.clearBadge).toHaveBeenCalledOnce();
		dispose?.();
		dispose = undefined;
		expect(mockGithub.stopPolling).toHaveBeenCalledOnce();
		expect(mockInvoke).not.toHaveBeenCalledWith("block_sleep");
		expect(mockInvoke).not.toHaveBeenCalledWith("unblock_sleep");
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
