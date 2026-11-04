import { getVersion } from "@tauri-apps/api/app";
import { onMount } from "solid-js";
import { initDeepLinkHandler } from "../deep-link-handler";
import { invoke } from "../invoke";
import { applyPlatformClass } from "../platform";
import { activityStore } from "../stores/activityStore";
import { agentConfigsStore } from "../stores/agentConfigs";
import { appLogger } from "../stores/appLogger";
import { dictationStore } from "../stores/dictation";
import { githubStore } from "../stores/github";
import { ideasStore } from "../stores/ideas";
import { keybindingsStore } from "../stores/keybindings";
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

// `registerRepo` is omitted too: it is supplied below from `openRepoPath`, so the
// caller passes one repo-registration function and both consumers (the deep link
// and the parked-tab toast) share it.
type InitOptions = Omit<AppInitDeps, "stores" | "applyPlatformClass" | "registerRepo">;

export type AppBootstrapOptions = InitOptions & {
	detectAgents: () => Promise<unknown>;
	restoreDetachedPanels: () => void;
	/** After an update restart, resume the agent tabs of every branch. */
	resumeAgentTabsAfterUpdate: () => Promise<void>;
	setWhatsNewVersion: (version: string) => void;
	openSettings: (tab?: string) => void;
	/** Add a repo by path — wired to the deep link `tuic://open-repo` (`fastaf <dir>`). */
	openRepoPath: (path: string) => Promise<void>;
	confirm: (options: {
		title: string;
		message: string;
		okLabel?: string;
		cancelLabel?: string;
		kind: "info" | "warning";
	}) => Promise<boolean>;
};

async function hydrateStores(): Promise<void> {
	const results = await Promise.allSettled([
		repositoriesStore.hydrate(),
		uiStore.hydrate(),
		settingsStore.hydrate(),
		notificationsStore.hydrate(),
		repoSettingsStore.hydrate(),
		repoDefaultsStore.hydrate(),
		promptLibraryStore.hydrate(),
		ideasStore.hydrate(),
		activityStore.hydrate(),
		keybindingsStore.hydrate(),
		agentConfigsStore.hydrate(),
		// FastAF: the built-in AI engine reads its configured providers from here.
		providerRegistryStore.hydrate(),
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
				title: "Install fastaf CLI?",
				message:
					"The fastaf command lets you control FastAF from the terminal:\n\n" +
					"• fastaf open file.rs:42 — open files with line numbers\n" +
					"• fastaf ls / new / send — manage terminal sessions\n" +
					"• fastaf agent spawn claude — spawn AI agents\n" +
					"• Works as a tmux replacement (fastaf alias)\n\n" +
					"Install to /usr/local/bin/fastaf? (You can always install later from Settings.)",
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
	const {
		detectAgents,
		restoreDetachedPanels,
		resumeAgentTabsAfterUpdate,
		setWhatsNewVersion,
		openSettings,
		openRepoPath,
		confirm,
		...initOptions
	} = options;

	await initApp({
		...initOptions,
		registerRepo: openRepoPath,
		stores: {
			hydrate: hydrateStores,
			startPolling: githubStore.startPolling,
			stopPolling: githubStore.stopPolling,
			startAutoFetch,
			startPrNotificationTimer: prNotificationsStore.startFocusTimer,
			loadFontFromConfig: settingsStore.loadFontFromConfig,
			startDictationSettingsSync: () => dictationStore.startRemoteSync(),
			refreshDictationConfig: () =>
				dictationStore.refreshConfig().then(() => {
					if (!dictationStore.state.enabled) return;
					dictationStore.refreshStatus();
					// A conversation outlives a WebView reload: reading its status
					// finds one still armed and brings its toast back. Reading
					// never opens the microphone.
					dictationStore.refreshHandsFree();
				}),
			startUserActivityListening: userActivityStore.startListening,
		},
		applyPlatformClass,
	}).catch((error) => {
		appLogger.error("app", "Fatal initialization error", error);
		options.setStatusInfo("Error: App failed to initialize — check error log");
		document.getElementById("splash")?.remove();
	});

	resumeAgentTabsAfterUpdate().catch((error) => appLogger.warn("app", "Resuming agents after update failed", error));
	detectAgents().catch((error) => appLogger.debug("app", "Agent detection failed", error));

	restoreDetachedPanels();
	checkForUpdates();
	checkWhatsNew(setWhatsNewVersion);
	offerCliInstall(confirm);
	initDeepLinkHandler({
		openSettings,
		confirm: (title, message) => confirm({ title, message, kind: "warning" }),
		onInstallError: (message) => appLogger.error("plugin", message),
		openRepoPath,
	});
}

export function useAppBootstrap(options: AppBootstrapOptions): void {
	onMount(() => void runAppBootstrap(options));
}
