import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	setAiChatVisible: (_visible: boolean) => {},
	loads: 0,
	terminalEntries: [] as string[],
}));

vi.mock("../../stores/ui", async () => {
	const { createSignal } = await import("solid-js");
	const [visible, setVisible] = createSignal(false);
	state.setAiChatVisible = setVisible;
	return {
		uiStore: {
			state: {
				get aiChatPanelVisible() {
					return visible();
				},
			},
			isDetached: () => false,
			toggleAiChatPanel: () => setVisible((value) => !value),
		},
	};
});
vi.mock("../../stores/settings", () => ({
	settingsStore: { isAiChatEnabled: () => true, state: { suggestFollowups: false } },
}));
vi.mock("../../stores/globalWorkspace", () => ({ globalWorkspaceStore: { isActive: () => false } }));
vi.mock("../../stores/diffTabs", () => ({
	diffTabsStore: { add: () => {}, getIds: () => [], state: { activeId: null } },
}));
vi.mock("../../stores/editorTabs", () => ({ editorTabsStore: { getIds: () => [], state: { activeId: null } } }));
vi.mock("../../stores/mdTabs", () => ({ mdTabsStore: { getIds: () => [], state: { activeId: null } } }));
vi.mock("../../stores/paneLayout", () => ({ paneLayoutStore: { isSplit: () => false } }));
vi.mock("../../stores/repoSettings", () => ({ repoSettingsStore: { getEffectiveField: () => undefined } }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { getRepoPathForTerminal: () => null } }));
vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		getIds: () => ["terminal-1"],
		get: () => ({ cwd: "/repo" }),
		isDetached: () => false,
		state: { activeId: "terminal-1" },
	},
}));
vi.mock("../../hooks/useFileDrop", () => ({ useFileDrop: () => ({ isDragging: () => false, attachTo: () => {} }) }));
vi.mock("../../components/Terminal", () => ({
	Terminal: () => (
		<input
			aria-label="Terminal input"
			onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
				state.terminalEntries.push(event.currentTarget.value)
			}
		/>
	),
}));
vi.mock("../../components/PaneTree/PaneTree", () => ({ PaneNodeView: () => null }));
vi.mock("../../components/TipOfTheDay/TipOfTheDay", () => ({ default: () => null }));
vi.mock("../../components/SuggestOverlay/SuggestOverlay", () => ({ default: () => null }));
vi.mock("../../components/shared/MdTabContent", () => ({ MdTabContent: () => null }));
vi.mock("../../stores/progress", () => ({ progressStore: { dialogVisible: () => false } }));
vi.mock("../../stores/storiesUi", () => ({ storiesUi: { visible: () => false } }));
vi.mock("../../components/FileBrowserPanel", () => ({ FileBrowserPanel: () => null }));
vi.mock("../../components/MarkdownPanel", () => ({ MarkdownPanel: () => null }));
vi.mock("../../components/IdeasPanel", () => ({ IdeasPanel: () => null }));
vi.mock("../../components/OutlinePanel", () => ({ OutlinePanel: () => null }));
vi.mock("../../components/ReferencesPanel", () => ({ ReferencesPanel: () => null }));
vi.mock("../../components/GitPanel/GitPanel", () => ({ GitPanel: () => null }));
vi.mock("../../components/ProgressDialog", () => ({ ProgressDialog: () => null }));
vi.mock("../../components/AIChatPanel", () => {
	state.loads++;
	return { AIChatPanel: () => <div>AI Chat conversation</div> };
});

import { PanelOrchestrator } from "../../components/PanelOrchestrator";
import { TerminalArea } from "../../components/TerminalArea";

afterEach(() => {
	cleanup();
	state.setAiChatVisible(false);
	state.terminalEntries.length = 0;
});

it("keeps terminal input available before AI Chat loads and opens the panel on demand", async () => {
	render(() => (
		<TerminalArea onTerminalFocus={() => {}} onCloseTab={() => {}} onOpenFilePath={() => {}} onContextMenu={() => {}}>
			<PanelOrchestrator repoPath="/repo" onFileOpen={() => {}} />
		</TerminalArea>
	));
	expect(state.loads).toBe(0);
	fireEvent.input(screen.getByLabelText("Terminal input"), { target: { value: "echo ready" } });
	expect(state.terminalEntries).toEqual(["echo ready"]);

	state.setAiChatVisible(true);
	expect(await screen.findByText("AI Chat conversation")).toBeTruthy();
	fireEvent.input(screen.getByLabelText("Terminal input"), { target: { value: "echo still ready" } });
	expect(state.terminalEntries).toEqual(["echo ready", "echo still ready"]);
	state.setAiChatVisible(false);
	expect(screen.getByText("AI Chat conversation")).toBeTruthy();
});
