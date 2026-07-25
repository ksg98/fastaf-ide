import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAgentConfigs, mockContextActions, mockPaneLayout, mockTerminals, mockWriteClipboard } = vi.hoisted(() => ({
	mockAgentConfigs: { getRunConfigs: vi.fn() },
	mockContextActions: { getActions: vi.fn(), getContextActions: vi.fn() },
	mockPaneLayout: { state: { activeGroupId: null as string | null }, isSplit: vi.fn(), canSplit: vi.fn() },
	mockTerminals: {
		state: { activeId: null as string | null },
		getActive: vi.fn(),
		get: vi.fn(),
		update: vi.fn(),
	},
	mockWriteClipboard: vi.fn(),
}));

vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../platform", () => ({ getModifierSymbol: () => "⌘" }));
vi.mock("../../stores/agentConfigs", () => ({ agentConfigsStore: mockAgentConfigs }));
vi.mock("../../stores/contextMenuActionsStore", () => ({ contextMenuActionsStore: mockContextActions }));
vi.mock("../../stores/paneLayout", () => ({ paneLayoutStore: mockPaneLayout }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { state: { activeRepoPath: "/repo" } } }));
vi.mock("../../stores/settings", () => ({ settingsStore: { isAgentEnabled: vi.fn(() => true) } }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockTerminals }));
vi.mock("../../utils/clipboard", () => ({ writeClipboard: mockWriteClipboard }));
vi.mock("../../utils/hotkey", () => ({ keyFor: (action: string) => action }));
vi.mock("../../utils/sendCommand", () => ({
	getShellFamily: vi.fn().mockResolvedValue("posix"),
	sendCommand: vi.fn().mockResolvedValue(undefined),
}));

import { useTerminalContextMenus } from "../../hooks/useTerminalContextMenus";

function createOptions(available: Array<{ type: string }> = []) {
	return {
		agentDetection: { getAvailable: vi.fn(() => available) },
		gitOps: { handleAddTerminalToBranch: vi.fn().mockResolvedValue("new-term") },
		splitPanes: { handleSplit: vi.fn() },
		terminalLifecycle: { copyFromTerminal: vi.fn(), pasteToTerminal: vi.fn(), clearTerminal: vi.fn() },
		closeActiveTabOrPane: vi.fn(),
		setTermRenameDefault: vi.fn(),
		setTermRenamePromptVisible: vi.fn(),
	};
}

describe("useTerminalContextMenus", () => {
	beforeEach(() => {
		mockTerminals.state.activeId = null;
		mockTerminals.get.mockReset();
		mockTerminals.getActive.mockReset();
		mockTerminals.update.mockClear();
		mockAgentConfigs.getRunConfigs.mockReset().mockReturnValue([]);
		mockContextActions.getActions.mockReset().mockReturnValue([]);
		mockContextActions.getContextActions.mockReset().mockReturnValue([]);
		mockPaneLayout.isSplit.mockReset().mockReturnValue(false);
		mockPaneLayout.canSplit.mockReset().mockReturnValue(true);
		mockWriteClipboard.mockClear();
	});

	it("builds core terminal actions and disables splitting without an active terminal", () => {
		const options = createOptions();
		const menus = useTerminalContextMenus(options as never);

		const items = menus.getContextMenuItems();

		expect(items.map((item) => item.label)).toEqual(
			expect.arrayContaining(["Copy", "Paste", "Split Right", "Clear", "Close Terminal"]),
		);
		expect(items.find((item) => item.label === "Split Right")?.disabled).toBe(true);
	});

	it("copies only the last command block output", async () => {
		mockTerminals.state.activeId = "term-1";
		mockTerminals.get.mockReturnValue({
			commandBlocks: [{ executionLine: 10, endLine: 13 }],
			ref: { getBufferLines: vi.fn().mockResolvedValue(["output", ""]) },
		});
		const items = useTerminalContextMenus(createOptions() as never).getContextMenuItems();

		await items.find((item) => item.label === "Copy Block Output")?.action();

		expect(mockWriteClipboard).toHaveBeenCalledWith("output");
	});

	it("creates and configures a branch terminal from the sidebar agent action", async () => {
		mockTerminals.get.mockReturnValue({ tuicSession: "tuic-1" });
		const options = createOptions([{ type: "claude" }]);
		const menus = useTerminalContextMenus(options as never);

		const item = menus.buildSidebarAgentMenuItems("/repo", "feature")[0];
		await item.action();

		expect(options.gitOps.handleAddTerminalToBranch).toHaveBeenCalledWith("/repo", "feature");
		expect(mockTerminals.update).toHaveBeenCalledWith(
			"new-term",
			expect.objectContaining({ name: "Claude Code", agentType: "claude", agentLaunchCommand: "claude" }),
		);
	});

	it("keeps registered actions and smart prompts in separate groups", () => {
		mockTerminals.state.activeId = "term-1";
		mockTerminals.get.mockReturnValue({ sessionId: "session-1", commandBlocks: [] });
		mockContextActions.getActions.mockReturnValue([{ id: "legacy", label: "Legacy", action: vi.fn() }]);
		mockContextActions.getContextActions.mockImplementation((_target: string, filter: { pluginId?: string }) =>
			filter.pluginId ? [{ id: "prompt", label: "Prompt", action: vi.fn() }] : [],
		);

		const items = useTerminalContextMenus(createOptions() as never).getContextMenuItems();

		expect(items.find((item) => item.label === "Actions")?.children?.map((item) => item.label)).toEqual(["Legacy"]);
		expect(items.find((item) => item.label === "Prompts")?.children?.map((item) => item.label)).toEqual(["Prompt"]);
	});
});
