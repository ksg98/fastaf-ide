import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockListen, mockSetLastMenuActionTime, mockSettings, mockStores, mockTogglePanel } = vi.hoisted(
	() => ({
		handlers: new Map<string, (event: { payload: string }) => void>(),
		mockListen: vi.fn(),
		mockSetLastMenuActionTime: vi.fn(),
		mockSettings: { state: { confirmBeforeQuit: false }, isAiChatEnabled: vi.fn(() => true) },
		mockStores: {
			commandPalette: { open: vi.fn(), setQuery: vi.fn(), toggle: vi.fn() },
			diffTabs: { add: vi.fn() },
			errorLog: { toggle: vi.fn() },
			mcpPopup: { toggle: vi.fn() },
			promptLibrary: { toggleDrawer: vi.fn() },
			repositories: { state: { activeRepoPath: "/repo" } },
			terminals: { getIds: vi.fn(() => [] as string[]), get: vi.fn() },
			tunnels: { toggle: vi.fn() },
			ui: {
				toggleSidebar: vi.fn(),
				toggleMarkdownPanel: vi.fn(),
				toggleNotesPanel: vi.fn(),
				toggleFileBrowserPanel: vi.fn(),
				toggleOutlinePanel: vi.fn(),
				toggleFocusMode: vi.fn(),
				setDiffViewMode: vi.fn(),
				isDetached: vi.fn(() => false),
				toggleGitPanelOnTab: vi.fn(),
			},
			updater: { checkForUpdate: vi.fn().mockResolvedValue(undefined) },
		},
		mockTogglePanel: vi.fn(),
	}),
);

vi.mock("../../invoke", () => ({ listen: mockListen }));
vi.mock("../../menuDedup", () => ({ setLastMenuActionTime: mockSetLastMenuActionTime }));
vi.mock("../../panelRouter", () => ({ togglePanel: mockTogglePanel }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../stores/commandPalette", () => ({ commandPaletteStore: mockStores.commandPalette }));
vi.mock("../../stores/diffTabs", () => ({ diffTabsStore: mockStores.diffTabs }));
vi.mock("../../stores/errorLog", () => ({ errorLogStore: mockStores.errorLog }));
vi.mock("../../stores/mcpPopup", () => ({ mcpPopupStore: mockStores.mcpPopup }));
vi.mock("../../stores/promptLibrary", () => ({ promptLibraryStore: mockStores.promptLibrary }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: mockStores.repositories }));
vi.mock("../../stores/settings", () => ({ settingsStore: mockSettings }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockStores.terminals }));
vi.mock("../../stores/tunnelPanel", () => ({ tunnelPanelStore: mockStores.tunnels }));
vi.mock("../../stores/ui", () => ({ uiStore: mockStores.ui }));
vi.mock("../../stores/updater", () => ({ updaterStore: mockStores.updater }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: vi.fn() }));

import { dispatchNativeMenuAction, useNativeMenuBridge } from "../../hooks/useNativeMenuBridge";

function createOptions() {
	const shortcutHandlers = {
		newFile: vi.fn(),
		openFile: vi.fn(),
		openFolder: vi.fn(),
		openPath: vi.fn(),
		findInTerminal: vi.fn(),
		zoomIn: vi.fn(),
		zoomOut: vi.fn(),
		zoomReset: vi.fn(),
		toggleAiChatPanel: vi.fn(),
		toggleComposePanel: vi.fn(),
		toggleGlobalWorkspace: vi.fn(),
		blockPrev: vi.fn(),
		blockNext: vi.fn(),
		blockFoldToggle: vi.fn(),
		blockSearchToggle: vi.fn(),
		toggleWorktreeManager: vi.fn(),
		toggleBranchSwitcher: vi.fn(),
		toggleActivityDashboard: vi.fn(),
	};
	const terminalLifecycle = {
		reopenClosedTab: vi.fn(),
		copyFromTerminal: vi.fn(),
		clearTerminal: vi.fn(),
		clearScrollback: vi.fn(),
		refreshTerminal: vi.fn(),
		zoomInAll: vi.fn(),
		zoomOutAll: vi.fn(),
		zoomResetAll: vi.fn(),
		navigateTab: vi.fn(),
		terminalIds: vi.fn(() => ["tab-1", "tab-2"]),
		handleTerminalSelect: vi.fn(),
	};
	const gitOps = { handleNewTab: vi.fn(), handleRunCommand: vi.fn() };
	const splitPanes = { handleSplit: vi.fn(), toggleZoomPane: vi.fn() };
	return {
		shortcutHandlers,
		terminalLifecycle,
		gitOps,
		splitPanes,
		closeActiveTabOrPane: vi.fn(),
		forceQuit: vi.fn(),
		setSettingsPanelVisible: vi.fn(),
		setQuitDialogVisible: vi.fn(),
		setRunCommandDialogVisible: vi.fn(),
		setTaskQueueVisible: vi.fn(),
		setShowProcessManager: vi.fn(),
		setHelpPanelVisible: vi.fn(),
	};
}

describe("native menu bridge", () => {
	let dispose: (() => void) | undefined;
	const unlisteners: Array<ReturnType<typeof vi.fn>> = [];

	beforeEach(() => {
		handlers.clear();
		unlisteners.length = 0;
		mockListen.mockReset().mockImplementation((event: string, handler: (event: { payload: string }) => void) => {
			handlers.set(event, handler);
			const unlisten = vi.fn();
			unlisteners.push(unlisten);
			return Promise.resolve(unlisten);
		});
		mockSettings.state.confirmBeforeQuit = false;
		mockStores.terminals.getIds.mockReturnValue([]);
		mockStores.terminals.get.mockReset();
		vi.clearAllMocks();
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("dispatches file, terminal, view, navigation, and tool actions to their owners", () => {
		const options = createOptions();

		dispatchNativeMenuAction("new-file", options as never);
		dispatchNativeMenuAction("copy", options as never);
		dispatchNativeMenuAction("split-right", options as never);
		dispatchNativeMenuAction("next-tab", options as never);
		dispatchNativeMenuAction("run-command", options as never);
		dispatchNativeMenuAction("switch-tab-2", options as never);

		expect(options.shortcutHandlers.newFile).toHaveBeenCalledOnce();
		expect(options.terminalLifecycle.copyFromTerminal).toHaveBeenCalledOnce();
		expect(options.splitPanes.handleSplit).toHaveBeenCalledWith("vertical");
		expect(options.terminalLifecycle.navigateTab).toHaveBeenCalledWith("next");
		expect(options.gitOps.handleRunCommand).toHaveBeenCalledWith(false, expect.any(Function));
		expect(options.terminalLifecycle.handleTerminalSelect).toHaveBeenCalledWith("tab-2");
	});

	it("shows quit confirmation only when configured terminals are active", () => {
		const options = createOptions();
		mockSettings.state.confirmBeforeQuit = true;
		mockStores.terminals.getIds.mockReturnValue(["tab-1"]);
		mockStores.terminals.get.mockReturnValue({ sessionId: "session-1" });

		dispatchNativeMenuAction("quit-app", options as never);

		expect(options.setQuitDialogVisible).toHaveBeenCalledWith(true);
		expect(options.forceQuit).not.toHaveBeenCalled();
	});

	it("routes diff scroll through the active repository", () => {
		dispatchNativeMenuAction("diff-scroll", createOptions() as never);

		expect(mockStores.ui.setDiffViewMode).toHaveBeenCalledWith("scroll");
		expect(mockStores.diffTabs.add).toHaveBeenCalledWith("/repo", "", "M");
	});

	it("listens for native menu and ctrl-tab events and cleans both up", async () => {
		const options = createOptions();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useNativeMenuBridge(options as never);
		});
		await Promise.resolve();

		handlers.get("menu-action")?.({ payload: "new-tab" });
		handlers.get("ctrl-tab")?.({ payload: "prev" });
		expect(mockSetLastMenuActionTime).toHaveBeenCalledOnce();
		expect(options.gitOps.handleNewTab).toHaveBeenCalledOnce();
		expect(options.terminalLifecycle.navigateTab).toHaveBeenCalledWith("prev");

		dispose?.();
		dispose = undefined;
		expect(unlisteners).toHaveLength(2);
		expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
	});
});
