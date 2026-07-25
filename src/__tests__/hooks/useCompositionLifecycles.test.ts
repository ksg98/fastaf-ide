import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAppearance, mockFileDrop, mockKeyboard, mockPlugin, mockTcc } = vi.hoisted(() => ({
	mockAppearance: { applyTheme: vi.fn(), applyFont: vi.fn(), loaded: vi.fn(() => true) },
	mockFileDrop: { setHandler: vi.fn() },
	mockKeyboard: { register: vi.fn(), cleanup: vi.fn() },
	mockPlugin: { init: vi.fn().mockResolvedValue(undefined), notify: vi.fn() },
	mockTcc: { paths: vi.fn(() => [] as string[]), markShown: vi.fn() },
}));

vi.mock("../../hooks/useFileDrop", () => ({ setFolderDropConfirmHandler: mockFileDrop.setHandler }));
vi.mock("../../hooks/useRepository", () => ({
	tccDeniedPaths: mockTcc.paths,
	markTccAlertShown: mockTcc.markShown,
}));
vi.mock("../../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: mockKeyboard.register }));
vi.mock("../../plugins", () => ({ initPlugins: mockPlugin.init }));
vi.mock("../../plugins/pluginRegistry", () => ({ pluginRegistry: { notifyStateChange: mockPlugin.notify } }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn() } }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { state: { activeRepoPath: "/repo" } } }));
vi.mock("../../stores/settings", () => ({ settingsStore: { state: { theme: "dark", font: "JetBrains Mono" } } }));
vi.mock("../../themes", () => ({
	applyAppTheme: mockAppearance.applyTheme,
	applyFontFamily: mockAppearance.applyFont,
	themesLoaded: mockAppearance.loaded,
}));

import { useAppearanceSync } from "../../hooks/useAppearanceSync";
import { useDialogIntegrations } from "../../hooks/useDialogIntegrations";
import { usePluginRuntime } from "../../hooks/usePluginRuntime";
import { useShortcutRegistration } from "../../hooks/useShortcutRegistration";

describe("composition lifecycles", () => {
	let dispose: (() => void) | undefined;

	beforeEach(() => {
		mockAppearance.applyTheme.mockClear();
		mockAppearance.applyFont.mockClear();
		mockFileDrop.setHandler.mockClear();
		mockKeyboard.cleanup.mockClear();
		mockKeyboard.register.mockReset().mockReturnValue(mockKeyboard.cleanup);
		mockPlugin.init.mockReset().mockResolvedValue(undefined);
		mockTcc.paths.mockReset().mockReturnValue([]);
		mockTcc.markShown.mockClear();
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("synchronizes the current theme and font", () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useAppearanceSync();
		});

		expect(mockAppearance.applyTheme).toHaveBeenCalledWith("dark");
		expect(mockAppearance.applyFont).toHaveBeenCalledWith("JetBrains Mono");
	});

	it("connects folder-drop confirmation and reports denied repository paths", async () => {
		mockTcc.paths.mockReturnValue(["/Users/test/Documents/repo"]);
		const confirm = vi.fn().mockResolvedValue(true);
		const setPendingFolderDrop = vi.fn();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useDialogIntegrations({ setPendingFolderDrop, confirm });
		});
		await vi.waitFor(() => expect(mockFileDrop.setHandler).toHaveBeenCalledOnce());

		expect(mockTcc.markShown).toHaveBeenCalledOnce();
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Permission denied" }));
	});

	it("initializes plugins from the component mount lifecycle", async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			usePluginRuntime();
		});
		await Promise.resolve();

		expect(mockPlugin.init).toHaveBeenCalledOnce();
	});

	it("owns keyboard registration cleanup", () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useShortcutRegistration({} as never);
		});

		expect(mockKeyboard.register).toHaveBeenCalledOnce();
		dispose?.();
		dispose = undefined;
		expect(mockKeyboard.cleanup).toHaveBeenCalledOnce();
	});
});
