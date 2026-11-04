import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

import { appLogger } from "../../stores/appLogger";
import { mockInvoke } from "../mocks/tauri";

vi.mock("../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsExpertMode: vi.fn((enabled: boolean) => setState("settingsExpertMode", enabled)),
		},
	};
});

import { settingsExpertStore } from "../../stores/settingsExpert";
import { uiStore } from "../../stores/ui";

const KEY = "app.osc52_clipboard";
const DEFAULTS = { app: { osc52_clipboard: true }, notifications: {}, agent_settings: {} };

function serveDefaults(): void {
	mockInvoke.mockImplementation((cmd: string) =>
		cmd === "get_config_defaults" ? Promise.resolve(DEFAULTS) : Promise.resolve(undefined),
	);
}

describe("settingsExpertStore visibility within one Settings open", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
		serveDefaults();
	});

	it("keeps an edited control visible after its value returns to the default, until the next open()", async () => {
		// Resetting an override must not make the control vanish under the user's cursor.
		await settingsExpertStore.open();
		expect(settingsExpertStore.isVisible(KEY, false)).toBe(true);

		settingsExpertStore.pin(KEY);
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(true);

		await settingsExpertStore.open();
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
	});

	it("hides a placeholder non-default value that resolves to the default without a user edit", async () => {
		// A tab's pre-load placeholder (e.g. [] before load_config) is not an override.
		await settingsExpertStore.open();
		expect(settingsExpertStore.isVisible(KEY, false)).toBe(true);

		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
	});

	it("does not pin a control that was visible only because defaults were still loading", async () => {
		// Pinning here would show every expert control on the first open.
		let resolveDefaults: (value: unknown) => void = () => {};
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "get_config_defaults"
				? new Promise((resolve) => {
						resolveDefaults = resolve;
					})
				: Promise.resolve(undefined),
		);
		const opening = settingsExpertStore.open();
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(true);

		resolveDefaults(DEFAULTS);
		await opening;
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
	});

	it("hides an at-default control when expert mode is switched off in the same open", async () => {
		// The Expert switch is an explicit request to hide; it must act immediately.
		await settingsExpertStore.open();
		uiStore.setSettingsExpertMode(true);
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(true);

		uiStore.setSettingsExpertMode(false);
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
	});

	it("does not keep a control visible that was never visible this open", async () => {
		await settingsExpertStore.open();
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
		expect(settingsExpertStore.isVisible(KEY, true)).toBe(false);
	});

	it("logs a defaults-load failure and keeps expert controls visible", async () => {
		const failure = new Error("defaults unavailable");
		const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "get_config_defaults" ? Promise.reject(failure) : Promise.resolve(undefined),
		);

		await settingsExpertStore.open();

		expect(settingsExpertStore.isVisible(KEY, true)).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			"config",
			"Failed to load config defaults; expert settings stay visible",
			failure,
		);
	});
});

describe("settingsExpertStore default lookup", () => {
	/** The payload shape `get_config_defaults` returns: `None` fields are omitted. */
	const PAYLOAD = {
		app: { osc52_clipboard: true, services: { auth: { session_token_duration_secs: 3600 } } },
		notifications: { volume: 0.5 },
		agent_settings: { run_configs: [] },
		repo_defaults: { after_merge: "archive", pr_merge_strategy: "squash" },
		agents: { agents: {} },
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		settingsExpertStore._resetForTests();
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "get_config_defaults" ? Promise.resolve(PAYLOAD) : Promise.resolve(undefined),
		);
		await settingsExpertStore.open();
	});

	it("resolves the repo_defaults domain", () => {
		expect(settingsExpertStore.isAtDefault("repo_defaults.after_merge", "archive")).toBe(true);
		expect(settingsExpertStore.isAtDefault("repo_defaults.after_merge", "delete")).toBe(false);
	});

	it("treats a key serde omitted from a present domain as a null default", () => {
		// `audio_device: None` is skipped on serialize, so it never reaches the payload.
		const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
		expect(settingsExpertStore.isAtDefault("notifications.audio_device", null)).toBe(true);
		expect(settingsExpertStore.isAtDefault("notifications.audio_device", "Speakers")).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("treats an omitted agent_settings key as a null default", () => {
		// hook_instrumentation, native_status_signals, env_flags … are skip_serializing_if.
		expect(settingsExpertStore.isAtDefault("agent_settings.hook_instrumentation", null)).toBe(true);
		expect(settingsExpertStore.isAtDefault("agent_settings.hook_instrumentation", true)).toBe(false);
	});

	it("resolves agents.headless_agent, omitted while None, as null", () => {
		expect(settingsExpertStore.isAtDefault("agents.headless_agent", null)).toBe(true);
		expect(settingsExpertStore.isAtDefault("agents.headless_agent", "claude")).toBe(false);
	});

	it("still counts an absent domain and a missing parent object as not at default", () => {
		const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
		// Only a leaf inside a present object can be an omitted None.
		expect(settingsExpertStore.isAtDefault("dictation.enabled", null)).toBe(false);
		expect(settingsExpertStore.isAtDefault("app.services.missing.port", null)).toBe(false);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"config",
			'Expert setting "app.services.missing.port" has no config default',
		);
	});
});
