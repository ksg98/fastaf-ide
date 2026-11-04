import path from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
	plugins: [solid()],
	resolve: {
		alias: process.env.TUIC_APPLICATION_PREVIEW
			? [
					...[
						"stores/agentConfigs",
						"stores/remoteConnections",
						"stores/editorTabs",
						"stores/settingsExpert",
						"hooks/useAgentDetection",
						"plugins",
						"plugins/pluginLoader",
					].map((module) => ({
						find: new RegExp(`^(?:\\.\\./)+${module}$`),
						replacement: path.resolve("src/components/SettingsPanel/fields/agents-preview-state.js"),
					})),
					...[
						"stores/settings",
						"themes",
						"stores/github",
						"stores/repoDefaults",
						"stores/updater",
						"stores/repositories",
						"stores/notifications",
						"stores/transcriptPreferences",
						"services/tasksNotifications",
						"services/settingsRefresh",
						"stores/ui",
						"stores/appLogger",
						"transport",
						"invoke",
						"utils/nativeDialog",
					].map((module) => ({
						find: new RegExp(`^(?:\\.\\./)+${module}$`),
						replacement: path.resolve("src/components/SettingsPanel/fields/application-preview-state.js"),
					})),
					{
						find: "../../HelpPanel/UiLegend",
						replacement: path.resolve("src/components/SettingsPanel/fields/application-preview-state.js"),
					},
					{
						find: "../ExpertSetting",
						replacement: path.resolve("src/components/SettingsPanel/fields/application-preview-state.js"),
					},
				]
			: [],
	},
	define: { __APP_VERSION__: JSON.stringify("preview") },
});
