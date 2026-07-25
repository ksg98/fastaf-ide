import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { get: vi.fn() } }));
vi.mock("../../stores/terminals", () => ({
	terminalsStore: { getIds: vi.fn(() => []), get: vi.fn(), update: vi.fn() },
}));

import { folderDropMessage, useQuitDialogKeyCapture } from "../../components/ApplicationOverlays/ApplicationOverlays";

describe("ApplicationOverlays", () => {
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
			useQuitDialogKeyCapture(() => true, setQuitDialogVisible);
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
			useQuitDialogKeyCapture(() => true, setQuitDialogVisible);
			return rootDispose;
		});
		dispose();

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(setQuitDialogVisible).not.toHaveBeenCalled();
	});
});
