import { beforeEach, expect, it, vi } from "vitest";

vi.unmock("@tauri-apps/api/window");
vi.unmock("@tauri-apps/api/core");
const nativeInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../invoke", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("../stores/settings", () => ({
	DEFAULT_THEME: "commander",
	FONT_FAMILIES: {},
	settingsStore: { state: { theme: "commander" } },
}));
vi.mock("../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));
const environment = vi.hoisted(() => ({ desktop: true }));
vi.mock("../transport", () => ({ isTauri: () => environment.desktop }));

const bundled = import.meta.glob<{
	default: { name: string; background: string; appChrome?: { background?: string } };
}>("../../src-tauri/src/themes/*.json", { eager: true });

beforeEach(() => {
	vi.resetModules();
	nativeInvoke.mockReset().mockResolvedValue(undefined);
	environment.desktop = true;
	Object.assign(window, {
		__TAURI_INTERNALS__: {
			invoke: nativeInvoke,
			metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
			transformCallback: () => 0,
		},
	});
});

// Catches: theme changes update CSS while leaving either native backing layer white or on the previous theme.
it("sets window and webview backgrounds to every bundled theme including light themes", async () => {
	const { invoke } = await import("../invoke");
	const { appLogger } = await import("../stores/appLogger");
	const entries = Object.entries(bundled).map(([path, { default: theme }]) => ({
		key: path.slice(path.lastIndexOf("/") + 1).replace(".json", ""),
		name: theme.name,
		terminal: {
			background: theme.background,
			foreground: "#cccccc",
			cursor: "#cccccc",
			cursor_accent: null,
			selection_background: null,
			ansi: [],
		},
		app_chrome: { bg_primary: theme.appChrome?.background ?? theme.background, accent: "#123456" },
	}));
	vi.mocked(invoke).mockResolvedValue(entries);
	const { loadThemes, applyAppTheme } = await import("../themes");
	await loadThemes();
	for (const entry of entries) {
		nativeInvoke.mockClear();
		applyAppTheme(entry.key, false);
		// The webview-window SDK applies the two transport calls sequentially.
		await vi.waitFor(() => {
			expect(appLogger.warn).not.toHaveBeenCalled();
			expect(nativeInvoke).toHaveBeenCalledWith(
				"plugin:webview|set_webview_background_color",
				{
					label: "main",
					value: entry.app_chrome.bg_primary,
				},
				undefined,
			);
		});
		expect(nativeInvoke).toHaveBeenCalledWith(
			"plugin:window|set_background_color",
			{
				label: "main",
				value: entry.app_chrome.bg_primary,
			},
			undefined,
		);
		expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe(entry.app_chrome.bg_primary);
	}
});

// Catches: a slow older theme leaves the webview on its old color after the next window color is set.
it("keeps window and webview pairs ordered during rapid theme changes", async () => {
	let release = () => {};
	nativeInvoke.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const { syncWindowBackground } = await import("../utils/windowBackground");
	syncWindowBackground("#112233");
	syncWindowBackground("#ffffff");
	await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1));
	release();
	await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(4));
	expect(nativeInvoke.mock.calls.map(([command, args]) => [command, args.value])).toEqual([
		["plugin:window|set_background_color", "#112233"],
		["plugin:webview|set_webview_background_color", "#112233"],
		["plugin:window|set_background_color", "#ffffff"],
		["plugin:webview|set_webview_background_color", "#ffffff"],
	]);
});

// Catches: one rejected native write prevents every later theme update.
it("reports a native background failure and applies the next theme", async () => {
	nativeInvoke.mockRejectedValueOnce(new Error("window unavailable"));
	const { syncWindowBackground } = await import("../utils/windowBackground");
	const { appLogger } = await import("../stores/appLogger");
	syncWindowBackground("#112233");
	syncWindowBackground("#ffffff");
	await vi.waitFor(() =>
		expect(nativeInvoke).toHaveBeenCalledWith(
			"plugin:webview|set_webview_background_color",
			{
				label: "main",
				value: "#ffffff",
			},
			undefined,
		),
	);
	expect(appLogger.warn).toHaveBeenCalledWith("app", "Failed to sync native window background", {
		error: expect.any(Error),
	});
});

// Catches: browser theme application tries to call a native-only window transport.
it("does not request native backgrounds in browser mode", async () => {
	environment.desktop = false;
	const { syncWindowBackground } = await import("../utils/windowBackground");
	syncWindowBackground("#ffffff");
	await Promise.resolve();
	expect(nativeInvoke).not.toHaveBeenCalled();
});
