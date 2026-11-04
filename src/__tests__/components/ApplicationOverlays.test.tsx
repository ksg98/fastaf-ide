import { fireEvent, render } from "@solidjs/testing-library";
import { type ComponentProps, createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));
vi.mock("../../transport", async (original) => ({
	...(await original<typeof import("../../transport")>()),
	rpc: mockRpc,
}));
vi.mock("../../stores/closeDialog", () => ({ closeDialogStore: { state: { request: null }, answer: vi.fn() } }));
vi.mock("../../components/McpConfirmHost/McpConfirmHost", () => ({ McpConfirmHost: () => null }));

vi.mock("../../components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../../components/ContextMenu", () => ({ ContextMenu: () => null }));
vi.mock("../../components/CreateBranchDialog", () => ({ CreateBranchDialog: () => null }));
vi.mock("../../components/CreateWorktreeDialog", () => ({ CreateWorktreeDialog: () => null }));
vi.mock("../../components/GeneratorsModal", () => ({ GeneratorsModal: () => null }));
vi.mock("../../components/HelpPanel", () => ({ HelpPanel: () => null }));
vi.mock("../../components/PostMergeCleanupDialog/PostMergeCleanupDialog", () => ({
	PostMergeCleanupDialog: () => null,
}));
vi.mock("../../components/ProcessManagerModal/ProcessManagerModal", () => ({ ProcessManagerModal: () => null }));
vi.mock("../../components/PromptDialog", () => ({ PromptDialog: () => null }));
vi.mock("../../components/RemoteQrDialog", () => ({ RemoteQrDialog: () => null }));
vi.mock("../../components/RenameBranchDialog", () => ({ RenameBranchDialog: () => null }));
vi.mock("../../components/RunCommandDialog", () => ({ RunCommandDialog: () => null }));
vi.mock("../../components/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("../../components/TaskQueuePanel", () => ({ TaskQueuePanel: () => null }));
vi.mock("../../components/UpdateProgressDialog", () => ({ UpdateProgressDialog: () => null }));
vi.mock("../../components/WhatsNewDialog/WhatsNewDialog", () => ({ WhatsNewDialog: () => null }));
// FastAF dialogs: not under test here.
vi.mock("../../components/CloneRepoDialog", () => ({ CloneRepoDialog: () => null }));
vi.mock("../../components/ImportDialog", () => ({ ImportDialog: () => null }));
vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { get: vi.fn() } }));
vi.mock("../../stores/terminals", () => ({
	terminalsStore: { getIds: vi.fn(() => []), get: vi.fn(), update: vi.fn() },
}));

import { ApplicationOverlays, folderDropMessage } from "../../components/ApplicationOverlays/ApplicationOverlays";
import { useCloseDialogKeyCapture } from "../../components/QuitDialog/CloseDialog";

describe("ApplicationOverlays", () => {
	// Catches: browser Add Repository still mounts the text prompt instead of a browsable server picker.
	it("opens server folders through the repository prompt and resolves selection or cancellation", async () => {
		mockRpc.mockImplementation(async (command: string) => {
			if (command === "get_home_directory") return "/overlay-home";
			if (command === "list_directory") return [{ name: "projects", is_dir: true }];
			throw new Error(`Unexpected picker command: ${command}`);
		});
		const [visible, setVisible] = createSignal(true);
		const resolveRepoPath = vi.fn(() => setVisible(false));
		// All unrelated overlays stay closed. Their own components are mocked above.
		const closed = new Proxy({}, { get: () => () => null });
		const props = {
			panels: closed,
			contextMenu: closed,
			getContextMenuItems: () => [],
			git: closed,
			confirmations: closed,
			utilities: closed,
			cleanup: closed,
			quitVisible: () => false,
			setQuitVisible: vi.fn(),
			forceQuit: vi.fn(),
			prompts: {
				terminalRenameVisible: () => false,
				closeTerminalRename: vi.fn(),
				terminalRenameDefault: () => "",
				openPathVisible: () => false,
				resolveOpenPath: vi.fn(),
				repoPathVisible: visible,
				resolveRepoPath,
				remotePickerConnectionId: () => null,
				resolveRemotePicker: vi.fn(),
			},
		} as unknown as ComponentProps<typeof ApplicationOverlays>;
		const view = render(() => <ApplicationOverlays {...props} />);
		await view.findByText("projects");
		fireEvent.click(view.getByText("Add This Folder"));
		expect(resolveRepoPath).toHaveBeenCalledWith("/overlay-home");
		resolveRepoPath.mockClear();
		setVisible(true);
		await view.findByText("projects");
		fireEvent.click(view.getByText("Cancel"));
		expect(resolveRepoPath).toHaveBeenCalledExactlyOnceWith(null);
	});

	it("describes copy and move folder transfers", () => {
		expect(folderDropMessage(null)).toBe("");
		expect(folderDropMessage({ mode: "copy", paths: ["/a"], destDir: "/dest" })).toContain(
			"recursively copy 1 item into /dest",
		);
		expect(folderDropMessage({ mode: "move", paths: ["/a", "/b"], destDir: "/dest" })).toContain(
			"recursively move 2 items into /dest",
		);
	});

	it("captures Enter and Escape while quit confirmation is visible", () => {
		const setQuitDialogVisible = vi.fn();
		const dispose = createRoot((rootDispose) => {
			useCloseDialogKeyCapture(
				() => true,
				() => setQuitDialogVisible(false),
			);
			return rootDispose;
		});

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
		expect(setQuitDialogVisible).not.toHaveBeenCalled();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

		expect(setQuitDialogVisible).toHaveBeenCalledTimes(2);
		expect(setQuitDialogVisible).toHaveBeenCalledWith(false);
		dispose();
	});

	it("removes the quit key capture listener on unmount", () => {
		const setQuitDialogVisible = vi.fn();
		const dispose = createRoot((rootDispose) => {
			useCloseDialogKeyCapture(
				() => true,
				() => setQuitDialogVisible(false),
			);
			return rootDispose;
		});
		dispose();

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(setQuitDialogVisible).not.toHaveBeenCalled();
	});
});
