import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockAiDispose,
	mockAppLogger,
	mockConversationStore,
	mockPromptLibraryStore,
	mockRegisterAiChatContextActions,
	mockSettingsStore,
	mockUiStore,
} = vi.hoisted(() => ({
	mockAiDispose: vi.fn(),
	mockAppLogger: { error: vi.fn() },
	mockConversationStore: { initFromDisk: vi.fn().mockResolvedValue(undefined) },
	mockPromptLibraryStore: { getSmartByPlacement: vi.fn() },
	mockRegisterAiChatContextActions: vi.fn(),
	mockSettingsStore: { enabled: false, isAiChatEnabled: vi.fn(() => false) },
	mockUiStore: {
		state: { aiChatPanelVisible: false },
		setAiChatPanelVisible: vi.fn(),
	},
}));

vi.mock("../../components/AIChatPanel/contextMenuActions", () => ({
	registerAiChatContextActions: mockRegisterAiChatContextActions,
}));
vi.mock("../../stores/appLogger", () => ({ appLogger: mockAppLogger }));
vi.mock("../../stores/conversationStore", () => ({ conversationStore: mockConversationStore }));
vi.mock("../../stores/promptLibrary", () => ({ promptLibraryStore: mockPromptLibraryStore }));
vi.mock("../../stores/settings", () => ({ settingsStore: mockSettingsStore }));
vi.mock("../../stores/ui", () => ({ uiStore: mockUiStore }));

import { usePluginContextActions } from "../../hooks/usePluginContextActions";
import { contextMenuActionsStore } from "../../stores/contextMenuActionsStore";
import type { SavedPrompt } from "../../stores/promptLibrary";

const branchPrompt = {
	id: "branch-prompt",
	name: "Review branch",
} as SavedPrompt;
const terminalPrompt = {
	id: "terminal-prompt",
	name: "Explain terminal",
} as SavedPrompt;

describe("usePluginContextActions", () => {
	let dispose: (() => void) | undefined;
	const executeSmartPrompt = vi.fn().mockResolvedValue({ ok: true });
	const canExecute = vi.fn(() => ({ ok: false, reason: "busy" }));

	beforeEach(() => {
		contextMenuActionsStore.clear();
		executeSmartPrompt.mockClear();
		canExecute.mockClear();
		mockAiDispose.mockClear();
		mockAppLogger.error.mockClear();
		mockConversationStore.initFromDisk.mockClear();
		mockRegisterAiChatContextActions.mockReset().mockReturnValue([{ dispose: mockAiDispose }]);
		mockSettingsStore.enabled = false;
		mockSettingsStore.isAiChatEnabled.mockImplementation(() => mockSettingsStore.enabled);
		mockUiStore.state.aiChatPanelVisible = false;
		mockUiStore.setAiChatPanelVisible.mockClear();
		mockPromptLibraryStore.getSmartByPlacement.mockImplementation((placement: string) => {
			if (placement === "git-branches") return [branchPrompt];
			if (placement === "terminal-context") return [terminalPrompt];
			return [];
		});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		contextMenuActionsStore.clear();
	});

	it("registers smart prompts with their target-specific behavior", async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			usePluginContextActions({ executeSmartPrompt, canExecute });
		});

		const branchAction = contextMenuActionsStore.getContextActions("branch")[0];
		const terminalAction = contextMenuActionsStore.getContextActions("terminal")[0];
		branchAction.action({ target: "branch", branchName: "feature/test" });
		terminalAction.action({ target: "terminal" });
		await Promise.resolve();

		expect(branchAction).toMatchObject({ id: "smart:branch-prompt", label: "Review branch" });
		expect(terminalAction).toMatchObject({ id: "smart:terminal-prompt", label: "Explain terminal" });
		expect(executeSmartPrompt).toHaveBeenNthCalledWith(1, branchPrompt, { branch_name: "feature/test" });
		expect(executeSmartPrompt).toHaveBeenNthCalledWith(2, terminalPrompt);
		expect(terminalAction.disabled?.({ target: "terminal" })).toBe(true);
		expect(canExecute).toHaveBeenCalledWith(terminalPrompt);
	});

	it("registers and disposes AI Chat actions while the feature is enabled", () => {
		mockSettingsStore.enabled = true;
		createRoot((rootDispose) => {
			dispose = rootDispose;
			usePluginContextActions({ executeSmartPrompt, canExecute });
		});

		expect(mockRegisterAiChatContextActions).toHaveBeenCalledOnce();
		expect(mockConversationStore.initFromDisk).toHaveBeenCalledOnce();

		dispose?.();
		dispose = undefined;
		expect(mockAiDispose).toHaveBeenCalledOnce();
		expect(contextMenuActionsStore.getContextActions("branch")).toEqual([]);
		expect(contextMenuActionsStore.getContextActions("terminal")).toEqual([]);
	});

	it("closes a visible AI Chat panel while the feature is disabled", () => {
		mockUiStore.state.aiChatPanelVisible = true;
		createRoot((rootDispose) => {
			dispose = rootDispose;
			usePluginContextActions({ executeSmartPrompt, canExecute });
		});

		expect(mockRegisterAiChatContextActions).not.toHaveBeenCalled();
		expect(mockUiStore.setAiChatPanelVisible).toHaveBeenCalledWith(false);
	});
});
