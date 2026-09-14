import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDeepLink,
	mockGetVersion,
	mockInitApp,
	mockInvoke,
	mockIsTauri,
	mockLogger,
	mockRegistryFetch,
	mockSettings,
	mockUpdaterCheck,
} = vi.hoisted(() => ({
	mockDeepLink: vi.fn(),
	mockGetVersion: vi.fn(),
	mockInitApp: vi.fn(),
	mockInvoke: vi.fn(),
	mockIsTauri: { value: true },
	mockLogger: { debug: vi.fn(), error: vi.fn() },
	mockRegistryFetch: vi.fn(),
	mockSettings: {
		state: { autoUpdateEnabled: true, autoUpdatePluginsEnabled: true },
		loadFontFromConfig: vi.fn(),
	},
	mockUpdaterCheck: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mockGetVersion }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../../deep-link-handler", () => ({ initDeepLinkHandler: mockDeepLink }));
vi.mock("../../invoke", () => ({ invoke: mockInvoke }));
vi.mock("../../platform", () => ({ applyPlatformClass: vi.fn(() => "macos") }));
vi.mock("../../transport", () => ({ isTauri: () => mockIsTauri.value }));
vi.mock("../../hooks/useAppInit", () => ({ initApp: mockInitApp }));
vi.mock("../../hooks/useAutoFetch", () => ({ startAutoFetch: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: mockLogger }));
vi.mock("../../stores/settings", () => ({ settingsStore: mockSettings }));
vi.mock("../../stores/updater", () => ({ updaterStore: { checkForUpdate: mockUpdaterCheck } }));
vi.mock("../../stores/registryStore", () => ({ registryStore: { fetch: mockRegistryFetch } }));
vi.mock("../../stores/github", () => ({ githubStore: { startPolling: vi.fn(), stopPolling: vi.fn() } }));
vi.mock("../../stores/prNotifications", () => ({ prNotificationsStore: { startFocusTimer: vi.fn() } }));
vi.mock("../../stores/dictation", () => ({
	dictationStore: {
		state: { enabled: false },
		refreshConfig: vi.fn().mockResolvedValue(undefined),
		refreshStatus: vi.fn(),
	},
}));
vi.mock("../../stores/userActivity", () => ({ userActivityStore: { startListening: vi.fn() } }));

import { type AppBootstrapOptions, runAppBootstrap } from "../../hooks/useAppBootstrap";

function makeOptions(overrides: Partial<AppBootstrapOptions> = {}): AppBootstrapOptions {
	return {
		pty: { listActiveSessions: vi.fn().mockResolvedValue([]), close: vi.fn().mockResolvedValue(undefined) },
		setQuitDialogVisible: vi.fn(),
		setStatusInfo: vi.fn(),
		setCurrentRepoPath: vi.fn(),
		setCurrentBranch: vi.fn(),
		handleBranchSelect: vi.fn().mockResolvedValue(undefined),
		refreshAllBranchStats: vi.fn(),
		handleWorktreeCreateFailed: vi.fn(),
		getDefaultFontSize: () => 14,
		detectAgents: vi.fn().mockResolvedValue(undefined),
		restoreDetachedPanels: vi.fn(),
		setWhatsNewVersion: vi.fn(),
		openSettings: vi.fn(),
		openRepoPath: vi.fn().mockResolvedValue(undefined),
		confirm: vi.fn().mockResolvedValue(false),
		...overrides,
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("runAppBootstrap", () => {
	beforeEach(() => {
		mockDeepLink.mockClear();
		mockGetVersion.mockReset().mockResolvedValue("2.0.0");
		mockInitApp.mockReset().mockResolvedValue(undefined);
		mockInvoke.mockReset().mockImplementation((command: string) => {
			if (command === "get_last_seen_version") return Promise.resolve("1.0.0");
			if (command === "get_cli_status") return Promise.resolve({ installed: true, prompt_dismissed: false });
			return Promise.resolve(undefined);
		});
		mockIsTauri.value = true;
		mockLogger.debug.mockClear();
		mockLogger.error.mockClear();
		mockRegistryFetch.mockReset().mockResolvedValue(undefined);
		mockUpdaterCheck.mockReset().mockResolvedValue(undefined);
		mockSettings.state.autoUpdateEnabled = true;
		mockSettings.state.autoUpdatePluginsEnabled = true;
	});

	it("starts post-hydration integrations after application initialization", async () => {
		const options = makeOptions();

		await runAppBootstrap(options);
		await flushPromises();

		expect(mockInitApp).toHaveBeenCalledOnce();
		expect(options.restoreDetachedPanels).toHaveBeenCalledOnce();
		expect(mockUpdaterCheck).toHaveBeenCalledOnce();
		expect(mockRegistryFetch).toHaveBeenCalledOnce();
		expect(options.setWhatsNewVersion).toHaveBeenCalledWith("2.0.0");
		expect(mockDeepLink).toHaveBeenCalledWith(expect.objectContaining({ openSettings: options.openSettings }));
	});

	it("starts agent detection only after splash-gating hydration completes", async () => {
		const detectAgents = vi.fn().mockResolvedValue(undefined);
		let detectionRanDuringHydration = false;
		mockInitApp.mockImplementationOnce(async (deps) => {
			const hydration = deps.stores.hydrate();
			await Promise.resolve();
			detectionRanDuringHydration = detectAgents.mock.calls.length > 0;
			await hydration;
		});

		await runAppBootstrap(makeOptions({ detectAgents }));
		await flushPromises();

		expect(detectionRanDuringHydration).toBe(false);
		expect(detectAgents).toHaveBeenCalledOnce();
	});

	it("offers and installs the CLI only for a first-run native user", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "get_last_seen_version") return Promise.resolve("2.0.0");
			if (command === "get_cli_status") return Promise.resolve({ installed: false, prompt_dismissed: false });
			return Promise.resolve(undefined);
		});
		const confirm = vi.fn().mockResolvedValue(true);

		await runAppBootstrap(makeOptions({ confirm }));
		await flushPromises();

		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Install tuic CLI?", kind: "info" }));
		expect(mockInvoke).toHaveBeenCalledWith("install_cli");
		expect(mockInvoke).toHaveBeenCalledWith("dismiss_cli_prompt");
	});

	it("reports fatal initialization failures but still installs recovery integrations", async () => {
		mockInitApp.mockRejectedValue(new Error("boom"));
		const splash = document.createElement("div");
		splash.id = "splash";
		document.body.append(splash);
		const options = makeOptions();

		await runAppBootstrap(options);

		expect(options.setStatusInfo).toHaveBeenCalledWith("Error: App failed to initialize — check error log");
		expect(document.getElementById("splash")).toBeNull();
		expect(options.restoreDetachedPanels).toHaveBeenCalledOnce();
		expect(mockDeepLink).toHaveBeenCalledOnce();
	});

	it("skips native-only version and CLI checks in browser mode", async () => {
		mockIsTauri.value = false;
		const options = makeOptions();

		await runAppBootstrap(options);
		await flushPromises();

		expect(mockGetVersion).not.toHaveBeenCalled();
		expect(mockInvoke).not.toHaveBeenCalledWith("get_cli_status");
		expect(options.setWhatsNewVersion).not.toHaveBeenCalled();
		expect(mockDeepLink).toHaveBeenCalledOnce();
	});
});
