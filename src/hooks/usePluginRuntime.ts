import { createEffect, on, onMount } from "solid-js";
import { initPlugins } from "../plugins";
import { pluginRegistry } from "../plugins/pluginRegistry";
import { appLogger } from "../stores/appLogger";
import { repositoriesStore } from "../stores/repositories";

/** Initializes plugins and forwards active-repository changes to plugin state observers. */
export function usePluginRuntime(): void {
	onMount(() => {
		initPlugins().catch((error) =>
			appLogger.error(
				"plugin",
				"Plugin initialization failed",
				error instanceof Error ? { stack: error.stack } : error,
			),
		);
	});
	createEffect(
		on(
			() => repositoriesStore.state.activeRepoPath,
			(repoPath) => {
				pluginRegistry.notifyStateChange({
					type: "repo-changed",
					sessionId: null,
					terminalId: "",
					detail: repoPath ?? undefined,
				});
			},
			{ defer: true },
		),
	);
}
