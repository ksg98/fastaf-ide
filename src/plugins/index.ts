import { destroyAgentUsage, initAgentUsage } from "../features/agentUsage";
import { pluginStore } from "../stores/pluginStore";
import { planPlugin } from "./planPlugin";
import {
	isPluginDisabled,
	loadUserPlugins,
	type PluginManifest,
	registerBuiltInPlugin,
	syncDisabledList,
} from "./pluginLoader";
import { pluginRegistry } from "./pluginRegistry";
import { storiesTickerPlugin } from "./storiesTickerPlugin";
import type { TuiPlugin } from "./types";

/**
 * Built-in plugins shipped with FastAF. Upstream 2.0 moved these two to external
 * packages; FastAF keeps them built in, and a leftover external package with the
 * same id is ignored (`BUILTIN_PLUGIN_IDS` in plugins.rs, `isBuiltInPlugin`).
 * Session prompts moved to native Rust (last_prompts in AppState, displayed in Activity Dashboard).
 * The agent usage ticker is a native feature (src/features/agentUsage.ts).
 */
const BUILTIN_PLUGINS: TuiPlugin[] = [planPlugin, storiesTickerPlugin];

/** What Settings › Manage plugins shows for a built-in, which has no manifest.json. */
const BUILTIN_LABELS: Record<string, { name: string; description: string }> = {
	plan: { name: "Plan Tracker", description: "Opens the plan files agents write as background tabs." },
	"stories-ticker": {
		name: "Stories Ticker",
		description: "Shows the active project's open story count in the status bar.",
	},
};

function builtInManifest(id: string): PluginManifest | null {
	const label = BUILTIN_LABELS[id];
	if (!label) return null;
	// Built-ins ship with the app, so they carry its version and declare no capabilities.
	return { id, ...label, version: __APP_VERSION__, minAppVersion: __APP_VERSION__, main: "", capabilities: [] };
}

/**
 * Register all built-in plugins, then discover and load user plugins.
 * Also initializes native features that use the disabled_plugin_ids toggle.
 * Call once at app startup.
 */
export async function initPlugins(): Promise<void> {
	// Sync disabled list before checking built-in plugin state
	await syncDisabledList();

	await Promise.all(
		BUILTIN_PLUGINS.map(async (plugin) => {
			registerBuiltInPlugin(plugin);
			const enabled = !isPluginDisabled(plugin.id);
			pluginStore.registerPlugin(plugin.id, { builtIn: true, enabled, manifest: builtInManifest(plugin.id) });
			if (enabled) {
				await pluginRegistry.register(plugin);
			}
		}),
	);

	// Native agent usage ticker (Claude + Codex) — uses the same
	// disabled_plugin_ids toggle, still keyed "claude-usage".
	if (!isPluginDisabled("claude-usage")) {
		initAgentUsage();
	}

	await loadUserPlugins(false);
}

/**
 * Toggle the native agent usage ticker (Claude + Codex).
 * Called from AgentsTab when user flips the dashboard toggle.
 */
export function setClaudeUsageEnabled(enabled: boolean): void {
	if (enabled) {
		initAgentUsage();
	} else {
		destroyAgentUsage();
	}
}
