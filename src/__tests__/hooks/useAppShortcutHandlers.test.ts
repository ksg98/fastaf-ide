import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDialogs, mockInvoke, mockNavigate, mockStores } = vi.hoisted(() => ({
	mockDialogs: { open: vi.fn(), save: vi.fn() },
	mockInvoke: vi.fn(),
	mockNavigate: vi.fn(),
	mockStores: {
		diff: { state: { activeId: null as string | null }, getHandle: vi.fn(), add: vi.fn() },
		editor: { state: { activeId: null as string | null }, getHandle: vi.fn() },
		markdown: {
			state: { activeId: null as string | null },
			getHandle: vi.fn(),
			zoomIn: vi.fn(),
			zoomOut: vi.fn(),
			zoomReset: vi.fn(),
			addCommandOverview: vi.fn(),
		},
		prompts: { getAllPrompts: vi.fn(), markAsUsed: vi.fn(), toggleDrawer: vi.fn() },
		repositories: {
			state: { activeRepoPath: "/repo" as string | null, repositories: { "/repo": { activeBranch: "main" } } },
		},
		terminals: {
			state: { activeId: "term-1" as string | null },
			getActive: vi.fn(),
			getPreviousActiveId: vi.fn(),
			getIds: vi.fn(),
			get: vi.fn(),
			isDetached: vi.fn(),
			toggleBlockFold: vi.fn(),
		},
		toasts: { add: vi.fn() },
		ui: {
			toggleFocusMode: vi.fn(),
			toggleMarkdownPanel: vi.fn(),
			toggleSidebar: vi.fn(),
			toggleNotesPanel: vi.fn(),
			toggleFileBrowserPanel: vi.fn(),
			requestFileBrowserContentSearch: vi.fn(),
			toggleOutlinePanel: vi.fn(),
			isDetached: vi.fn(),
			toggleGitPanelOnTab: vi.fn(),
			setDiffViewMode: vi.fn(),
			toggleAiTriagePanel: vi.fn(),
		},
	},
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mockDialogs.open, save: mockDialogs.save }));
vi.mock("../../invoke", () => ({ invoke: mockInvoke }));
vi.mock("../../keybindingDefaults", () => ({ normalizeCombo: (value: string) => value.toLowerCase() }));
vi.mock("../../panelRouter", () => ({ detachPanel: vi.fn(), togglePanel: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../stores/branchSwitcher", () => ({ branchSwitcherStore: { toggle: vi.fn() } }));
vi.mock("../../stores/commandPalette", () => ({ commandPaletteStore: { toggle: vi.fn() } }));
vi.mock("../../stores/diffTabs", () => ({ diffTabsStore: mockStores.diff }));
vi.mock("../../stores/editorTabs", () => ({ editorTabsStore: mockStores.editor }));
vi.mock("../../stores/errorLog", () => ({ errorLogStore: { toggle: vi.fn() } }));
vi.mock("../../stores/globalWorkspace", () => ({
	globalWorkspaceStore: { hasPromoted: vi.fn(() => false), isActive: vi.fn(), activate: vi.fn(), deactivate: vi.fn() },
}));
vi.mock("../../stores/mcpPopup", () => ({ mcpPopupStore: { toggle: vi.fn() } }));
vi.mock("../../stores/mdTabs", () => ({ mdTabsStore: mockStores.markdown }));
vi.mock("../../stores/promptLibrary", () => ({ promptLibraryStore: mockStores.prompts }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: mockStores.repositories }));
vi.mock("../../stores/savedPaneLayouts", () => ({ paneLayoutKey: vi.fn(() => "layout-key") }));
vi.mock("../../stores/settings", () => ({ settingsStore: { isAiTriageEnabled: vi.fn(() => true) } }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockStores.terminals }));
vi.mock("../../stores/toasts", () => ({ toastsStore: mockStores.toasts }));
vi.mock("../../stores/ui", () => ({ uiStore: mockStores.ui }));
vi.mock("../../stores/worktreeManager", () => ({ worktreeManagerStore: { toggle: vi.fn() } }));
vi.mock("../../transport", () => ({ isTauri: () => true }));
vi.mock("../../utils/navigateToTerminal", () => ({ navigateToTerminal: mockNavigate }));
vi.mock("../../utils/nextWaitingTerminal", () => ({ nextWaitingTerminal: vi.fn(() => "term-2") }));

import { useAppShortcutHandlers } from "../../hooks/useAppShortcutHandlers";

function createOptions() {
	const terminalLifecycle = new Proxy(
		{},
		{ get: (_target, key) => (key === "terminalIds" ? vi.fn(() => []) : vi.fn()) },
	);
	return {
		terminalLifecycle,
		gitOps: {
			handleNewTab: vi.fn(),
			handleRunCommand: vi.fn(),
			activeWorktreePath: vi.fn(() => "/worktree"),
		},
		splitPanes: { toggleZoomPane: vi.fn(), closeActivePane: vi.fn(), handleSplit: vi.fn() },
		quickSwitcher: { switchToBranchByIndex: vi.fn() },
		quickSwitcherVisible: () => false,
		closeActiveTabOrPane: vi.fn(),
		setRunCommandDialogVisible: vi.fn(),
		setSettingsPanelVisible: vi.fn(),
		setTaskQueueVisible: vi.fn(),
		setHelpPanelVisible: vi.fn(),
		setShowProcessManager: vi.fn(),
		setShowGenerators: vi.fn(),
		setShowRemoteQr: vi.fn(),
		promptOpenPath: vi.fn().mockResolvedValue(null),
		handleOpenFilePath: vi.fn(),
		revealFolderInBrowser: vi.fn(),
		executeSmartPrompt: vi.fn().mockResolvedValue({ ok: true }),
	};
}

describe("useAppShortcutHandlers", () => {
	beforeEach(() => {
		mockStores.diff.state.activeId = null;
		mockStores.editor.state.activeId = null;
		mockStores.markdown.state.activeId = null;
		mockStores.terminals.getActive.mockReset().mockReturnValue({ ref: { openSearch: vi.fn() }, commandBlocks: [] });
		mockStores.terminals.getPreviousActiveId.mockReset().mockReturnValue("term-previous");
		mockStores.terminals.getIds.mockReset().mockReturnValue([]);
		mockStores.terminals.get.mockReset();
		mockStores.prompts.getAllPrompts.mockReset().mockReturnValue([]);
		mockInvoke.mockReset().mockResolvedValue(undefined);
		vi.clearAllMocks();
	});

	it("routes search to diff, markdown, editor, then terminal in priority order", () => {
		const diffSearch = vi.fn();
		const markdownSearch = vi.fn();
		const editorSearch = vi.fn();
		const terminalSearch = vi.fn();
		mockStores.terminals.getActive.mockReturnValue({ ref: { openSearch: terminalSearch }, commandBlocks: [] });
		mockStores.diff.getHandle.mockReturnValue({ openSearch: diffSearch });
		mockStores.markdown.getHandle.mockReturnValue({ openSearch: markdownSearch });
		mockStores.editor.getHandle.mockReturnValue({ openSearch: editorSearch });
		const handlers = useAppShortcutHandlers(createOptions() as never);

		mockStores.diff.state.activeId = "diff";
		handlers.findInTerminal();
		mockStores.diff.state.activeId = null;
		mockStores.markdown.state.activeId = "markdown";
		handlers.findInTerminal();
		mockStores.markdown.state.activeId = null;
		mockStores.editor.state.activeId = "editor";
		handlers.findInTerminal();
		mockStores.editor.state.activeId = null;
		handlers.findInTerminal();

		expect(diffSearch).toHaveBeenCalledOnce();
		expect(markdownSearch).toHaveBeenCalledOnce();
		expect(editorSearch).toHaveBeenCalledOnce();
		expect(terminalSearch).toHaveBeenCalledOnce();
	});

	it("reloads an active preview before falling back to the run-command workflow", () => {
		const reload = vi.fn();
		const options = createOptions();
		const handlers = useAppShortcutHandlers(options as never);
		mockStores.markdown.state.activeId = "preview";
		mockStores.markdown.getHandle.mockReturnValue({ reload });

		handlers.handleRunCommand(false);
		expect(reload).toHaveBeenCalledOnce();
		expect(options.gitOps.handleRunCommand).not.toHaveBeenCalled();

		mockStores.markdown.state.activeId = null;
		handlers.handleRunCommand(true);
		expect(options.gitOps.handleRunCommand).toHaveBeenCalledWith(true, expect.any(Function));
	});

	it("routes typed paths by stat result", async () => {
		const options = createOptions();
		options.promptOpenPath.mockResolvedValueOnce("/folder").mockResolvedValueOnce("/file");
		mockInvoke
			.mockResolvedValueOnce({ exists: true, is_dir: true })
			.mockResolvedValueOnce({ exists: true, is_dir: false });
		const handlers = useAppShortcutHandlers(options as never);

		handlers.openPath();
		await Promise.resolve();
		await Promise.resolve();
		handlers.openPath();
		await Promise.resolve();
		await Promise.resolve();

		expect(options.revealFolderInBrowser).toHaveBeenCalledWith("/folder");
		expect(options.handleOpenFilePath).toHaveBeenCalledWith("/file");
	});

	it("navigates previous terminals and waiting terminals through the shared navigator", () => {
		mockStores.terminals.getIds.mockReturnValue(["term-1", "term-2"]);
		mockStores.terminals.get.mockReturnValue({ awaitingInput: "question" });
		mockStores.terminals.isDetached.mockReturnValue(false);
		const handlers = useAppShortcutHandlers(createOptions() as never);

		handlers.focusLastTerminal();
		handlers.jumpWaitingTerminal();

		expect(mockNavigate).toHaveBeenNthCalledWith(1, "term-previous");
		expect(mockNavigate).toHaveBeenNthCalledWith(2, "term-2");
	});

	it("executes and marks matching smart-prompt shortcuts", async () => {
		const prompt = { id: "prompt-1", name: "Review", shortcut: "Cmd+R", enabled: true };
		mockStores.prompts.getAllPrompts.mockReturnValue([prompt]);
		const options = createOptions();
		const handlers = useAppShortcutHandlers(options as never);

		expect(handlers.runSmartPromptByCombo("cmd+r")).toBe(true);
		await Promise.resolve();

		expect(mockStores.prompts.markAsUsed).toHaveBeenCalledWith("prompt-1");
		expect(options.executeSmartPrompt).toHaveBeenCalledWith(prompt);
	});
});
