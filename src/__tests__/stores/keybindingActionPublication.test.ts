import { expect, it, vi } from "vitest";
import "../mocks/tauri";
import { createKeybindingsStore } from "../../stores/keybindings";
import { mockInvoke } from "../mocks/tauri";

const { register } = vi.hoisted(() => ({
	register: vi.fn<(reader: { read: () => Promise<unknown> }) => () => void>(() => vi.fn()),
}));
vi.mock("../../services/settingsRefresh", () => ({
	settingsRefresh: { register },
	reportSettingsConflicts: vi.fn(),
}));

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

// Catches: live plugin registration/unload never updating the backend's shortcut choice resolver.
it("publishes_current_plugin_action_ids_without_saving_shortcut_overrides", async () => {
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(async (command: string) => (command === "load_keybindings" ? [] : { applied: true }));
	const store = createKeybindingsStore();
	store.registerDynamicAction({
		action: "plugin:fixture:run",
		label: "Fixture",
		pluginId: "fixture",
		defaultKey: undefined,
	});
	const stop = store.startRemoteSync();
	const reader = register.mock.calls.at(-1)![0];
	await reader.read();
	expect(mockInvoke).toHaveBeenCalledWith("settings_action", {
		request: {
			action: "publish_plugin_keybinding_actions",
			actions: ["plugin:fixture:run"],
		},
	});
	store.unregisterDynamicAction("plugin:fixture:run");
	await flush();
	expect(mockInvoke).toHaveBeenLastCalledWith("settings_action", {
		request: {
			action: "publish_plugin_keybinding_actions",
			actions: [],
		},
	});
	expect(mockInvoke.mock.calls.some(([command]) => command === "save_keybindings")).toBe(false);
	stop();
	mockInvoke.mockClear();
	store.registerDynamicAction({
		action: "plugin:fixture:after-stop",
		label: "Stopped",
		pluginId: "fixture",
		defaultKey: undefined,
	});
	await flush();
	expect(mockInvoke).not.toHaveBeenCalled();
});
