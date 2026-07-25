import { onCleanup } from "solid-js";
import { listen } from "../invoke";
import { conversationStore } from "../stores/conversationStore";
import type { SavedPrompt } from "../stores/promptLibrary";
import { settingsStore } from "../stores/settings";
import { toastsStore } from "../stores/toasts";
import { uiStore } from "../stores/ui";
import { handleWatcherFire, type WatcherFirePayload, watcherFireDeps } from "../stores/watcherFire";
import { switchToTerminalBySession } from "../utils/switchToTerminalBySession";

interface AutomationEventBridgeOptions {
	executeSmartPrompt: (prompt: SavedPrompt) => Promise<unknown>;
}

/** Routes backend AI suggestions and watcher automation events to their feature owners. */
export function useAutomationEventBridges(options: AutomationEventBridgeOptions): void {
	let unlistenSuggestion: (() => void) | undefined;
	listen<{ session_id: string; trigger_reason: string; proposed_goal: string }>("ai-suggestion", (event) => {
		const { session_id, trigger_reason, proposed_goal } = event.payload;
		toastsStore.add(trigger_reason, "", "warn", false, {
			label: "Investigate",
			onClick: () => {
				if (!settingsStore.isAiChatEnabled()) {
					toastsStore.add("Enable AI Chat in Settings to investigate", "", "warn", false);
					return;
				}
				uiStore.setAiChatPanelVisible(true);
				switchToTerminalBySession(session_id);
				conversationStore.startAgent(session_id, proposed_goal);
			},
		});
	}).then((dispose) => {
		unlistenSuggestion = dispose;
	});
	onCleanup(() => unlistenSuggestion?.());

	let unlistenWatcher: (() => void) | undefined;
	const deps = watcherFireDeps((prompt) => options.executeSmartPrompt(prompt));
	listen<WatcherFirePayload>("watcher-fire", (event) => {
		void handleWatcherFire(event.payload, deps);
	}).then((dispose) => {
		unlistenWatcher = dispose;
	});
	onCleanup(() => unlistenWatcher?.());
}
