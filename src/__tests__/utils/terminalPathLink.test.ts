import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTerminalPathLink } from "../../components/Terminal/terminalPathLink";
import { toastsStore } from "../../stores/toasts";
import { uiStore } from "../../stores/ui";
import "../mocks/tauri";

describe("terminal path link dispatch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		uiStore.setFileBrowserExternalRoot(null);
		uiStore.setFileBrowserPanelVisible(false);
		for (const toast of toastsStore.toasts) toastsStore.remove(toast.id);
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	it.each(["~/Gits/project", "../project"])("prevents directory %s from opening an empty editor", async (path) => {
		const invoke = vi.fn().mockResolvedValue({ absolute_path: "/home/boss/Gits/project", is_directory: true });
		const openFile = vi.fn();
		await openTerminalPathLink(path, "/home/boss/Gits/other", invoke, openFile);
		expect(invoke).toHaveBeenCalledWith("resolve_terminal_path", { cwd: "/home/boss/Gits/other", candidate: path });
		expect(uiStore.state.fileBrowserExternalRoot).toBe("/home/boss/Gits/project");
		expect(uiStore.state.fileBrowserPanelVisible).toBe(true);
		expect(openFile).not.toHaveBeenCalled();
	});

	it("prevents a missing OSC8 path from opening a permanently loading tab", async () => {
		const openFile = vi.fn();
		await openTerminalPathLink("/gone", "/repo", vi.fn().mockResolvedValue(null), openFile);
		expect(openFile).not.toHaveBeenCalled();
		expect(uiStore.state.fileBrowserPanelVisible).toBe(false);
		expect(toastsStore.toasts).toEqual([expect.objectContaining({ message: "Path not found: /gone" })]);
	});

	it("keeps file links in the editor with their resolved path and printed position", async () => {
		const openFile = vi.fn();
		await openTerminalPathLink(
			"src/main.rs",
			"/repo",
			vi.fn().mockResolvedValue({ absolute_path: "/repo/src/main.rs", is_directory: false }),
			openFile,
			42,
			6,
		);
		expect(openFile).toHaveBeenCalledWith("/repo/src/main.rs", 42, 6);
		expect(uiStore.state.fileBrowserPanelVisible).toBe(false);
	});

	it("prevents resolver failures from falling back to an unverified editor path", async () => {
		const openFile = vi.fn();
		await openTerminalPathLink("src/main.rs", "/repo", vi.fn().mockRejectedValue(new Error("offline")), openFile);
		expect(openFile).not.toHaveBeenCalled();
		expect(toastsStore.toasts).toEqual([expect.objectContaining({ message: "Could not open path: src/main.rs" })]);
	});
});
