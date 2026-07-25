import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onMount } from "solid-js";
import { initDeepLinkHandler } from "../deep-link-handler";
import { invoke } from "../invoke";
import { applyPlatformClass } from "../platform";
import { activityStore } from "../stores/activityStore";
import { agentConfigsStore } from "../stores/agentConfigs";
import { appLogger } from "../stores/appLogger";
import { dictationStore } from "../stores/dictation";
import { githubStore } from "../stores/github";
import { keybindingsStore } from "../stores/keybindings";
import { notesStore } from "../stores/notes";
import { notificationsStore } from "../stores/notifications";
import { prNotificationsStore } from "../stores/prNotifications";
import { promptLibraryStore } from "../stores/promptLibrary";
import { providerRegistryStore } from "../stores/providerRegistry";
import { registryStore } from "../stores/registryStore";
import { repoDefaultsStore } from "../stores/repoDefaults";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";
import { settingsStore } from "../stores/settings";
import { uiStore } from "../stores/ui";
import { updaterStore } from "../stores/updater";
import { userActivityStore } from "../stores/userActivity";
import { isTauri } from "../transport";
import { type AppInitDeps, initApp } from "./useAppInit";
import { startAutoFetch } from "./useAutoFetch";

type InitOptions = Omit<AppInitDeps, "stores" | "applyPlatformClass" | "onCloseRequested">;

export type AppBootstrapOptions = InitOptions & {
	detectAgents: () => Promise<unknown>;
	restoreDetachedPanels: () => void;
	setWhatsNewVersion: (version: string) => void;
	openSettings: (tab?: string) => void;
	confirm: (options: {
		title: string;
		message: string;
		okLabel?: string;
		cancelLabel?: string;
		kind: "info" | "warning";
	}) => Promise<boolean>;
};

async function hydrateStores(detectAgents: () => Promise<unknown>): Promise<void> {
	const results = await Promise.allSettled([
		repositoriesStore.hydrate(),
		uiStore.hydrate(),
		settingsStore.hydrate(),
		notificationsStore.hydrate(),
		repoSettingsStore.hydrate(),
		repoDefaultsStore.hydrate(),
		promptLibraryStore.hydrate(),
		notesStore.hydrate(),
		activityStore.hydrate(),
		keybindingsStore.hydrate(),
		agentConfigsStore.hydrate(),
		providerRegistryStore.hydrate(),
		detectAgents(),
	]);
	const failures = results.filter((result) => result.status === "rejected");
	if (failures.length > 0) {
		appLogger.error("store", `${failures.length} store(s) failed to hydrate`, failures);
		throw new Error(`${failures.length} store(s) failed`);
	}
}

function checkForUpdates(): void {
	if (settingsStore.state.autoUpdateEnabled) {
		updaterStore.checkForUpdate().catch((error) => appLogger.debug("app", "Updater auto-check failed", error));
	}
	if (settingsStore.state.autoUpdatePluginsEnabled) {
		registryStore.fetch().catch((error) => appLogger.debug("app", "Plugin registry fetch failed", error));
	}
}

function checkWhatsNew(setWhatsNewVersion: (version: string) => void): void {
	if (!isTauri()) return;
	Promise.all([getVersion(), invoke<string | null>("get_last_seen_version")])
		.then(([currentVersion, lastSeen]) => {
			const baseVersion = currentVersion.replace(/[-+].*$/, "");
			if (!lastSeen) {
				invoke("set_last_seen_version", { version: baseVersion }).catch(() => {});
				return;
			}
			if (lastSeen !== baseVersion && !currentVersion.includes("nightly")) {
				setWhatsNewVersion(baseVersion);
			}
		})
		.catch((error) => appLogger.debug("app", "Version check for What's New failed", error));
}

function offerCliInstall(confirm: AppBootstrapOptions["confirm"]): void {
	if (!isTauri()) return;
	invoke<{ installed: boolean; prompt_dismissed: boolean }>("get_cli_status")
		.then(async (status) => {
			if (status.installed || status.prompt_dismissed) return;
			const confirmed = await confirm({
				title: "Install tuic CLI?",
				message:
					"The tuic command lets you control FastAF from the terminal:\n\n" +
					"• tuic open file.rs:42 — open files with line numbers\n" +
					"• tuic ls / new / send — manage terminal sessions\n" +
					"• tuic agent spawn claude — spawn AI agents\n" +
					"• Works as a tmux replacement (tuic alias)\n\n" +
					"Install to /usr/local/bin/tuic? (You can always install later from Settings.)",
				kind: "info",
			});
			if (confirmed) {
				invoke("install_cli").catch((error) => appLogger.error("app", "CLI install failed", error));
			}
			invoke("dismiss_cli_prompt").catch(() => {});
		})
		.catch((error) => appLogger.debug("app", "get_cli_status failed, skipping CLI prompt", { error: String(error) }));
}

/** Initializes the main window and starts post-hydration native integrations. */
export async function runAppBootstrap(options: AppBootstrapOptions): Promise<void> {
	const { detectAgents, restoreDetachedPanels, setWhatsNewVersion, openSettings, confirm, ...initOptions } = options;

	await initApp({
		...initOptions,
		stores: {
			hydrate: () => hydrateStores(detectAgents),
			startPolling: githubStore.startPolling,
			stopPolling: githubStore.stopPolling,
			startAutoFetch,
			startPrNotificationTimer: prNotificationsStore.startFocusTimer,
			loadFontFromConfig: settingsStore.loadFontFromConfig,
			refreshDictationConfig: () =>
				dictationStore.refreshConfig().then(() => {
					if (dictationStore.state.enabled) dictationStore.refreshStatus();
				}),
			startUserActivityListening: userActivityStore.startListening,
		},
		applyPlatformClass,
		onCloseRequested: (handler) => {
			if (!isTauri()) return;
			void getCurrentWindow().onCloseRequested(async (event) => handler(event));
		},
	}).catch((error) => {
		appLogger.error("app", "Fatal initialization error", error);
		options.setStatusInfo("Error: App failed to initialize — check error log");
		document.getElementById("splash")?.remove();
	});

	restoreDetachedPanels();
	checkForUpdates();
	checkWhatsNew(setWhatsNewVersion);
	offerCliInstall(confirm);
	initDeepLinkHandler({
		openSettings,
		confirm: (title, message) => confirm({ title, message, kind: "warning" }),
		onInstallError: (message) => appLogger.error("plugin", message),
	});
}

export function useAppBootstrap(options: AppBootstrapOptions): void {
	onMount(() => void runAppBootstrap(options));
}
