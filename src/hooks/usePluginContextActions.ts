import { createEffect, onCleanup } from "solid-js";
import { registerAiChatContextActions } from "../components/AIChatPanel/contextMenuActions";
import { appLogger } from "../stores/appLogger";
import { contextMenuActionsStore } from "../stores/contextMenuActionsStore";
import { conversationStore } from "../stores/conversationStore";
import { promptLibraryStore, type SavedPrompt } from "../stores/promptLibrary";
import { settingsStore } from "../stores/settings";
import { uiStore } from "../stores/ui";

interface PluginContextActionOptions {
	executeSmartPrompt: (prompt: SavedPrompt, manualVariables?: Record<string, string>) => Promise<unknown>;
	canExecute: (prompt: SavedPrompt) => { ok: boolean };
}

/** Owns context-action registration lifecycles for built-in prompt and AI integrations. */
export function usePluginContextActions(options: PluginContextActionOptions): void {
	createEffect(() => {
		const disposables: Array<{ dispose(): void }> = [];
		for (const prompt of promptLibraryStore.getSmartByPlacement("git-branches")) {
			disposables.push(
				contextMenuActionsStore.registerContextAction("smart-prompts", {
					id: `smart:${prompt.id}`,
					label: prompt.name,
					target: "branch",
					action: (context) => {
						options
							.executeSmartPrompt(prompt, context.branchName ? { branch_name: context.branchName } : undefined)
							.catch((error) => appLogger.error("prompts", "Smart prompt execution failed", error));
					},
				}),
			);
		}
		onCleanup(() => disposables.forEach((disposable) => disposable.dispose()));
	});

	createEffect(() => {
		const disposables: Array<{ dispose(): void }> = [];
		for (const prompt of promptLibraryStore.getSmartByPlacement("terminal-context")) {
			disposables.push(
				contextMenuActionsStore.registerContextAction("smart-prompts", {
					id: `smart:${prompt.id}`,
					label: prompt.name,
					target: "terminal",
					action: () => {
						options
							.executeSmartPrompt(prompt)
							.catch((error) => appLogger.error("prompts", "Smart prompt execution failed", error));
					},
					disabled: () => !options.canExecute(prompt).ok,
				}),
			);
		}
		onCleanup(() => disposables.forEach((disposable) => disposable.dispose()));
	});

	let aiChatDisposables: Array<{ dispose(): void }> = [];
	createEffect(() => {
		aiChatDisposables.forEach((disposable) => disposable.dispose());
		aiChatDisposables = [];
		if (settingsStore.isAiChatEnabled()) {
			aiChatDisposables = registerAiChatContextActions();
			void conversationStore.initFromDisk();
		} else if (uiStore.state.aiChatPanelVisible) {
			uiStore.setAiChatPanelVisible(false);
		}
	});
	onCleanup(() => aiChatDisposables.forEach((disposable) => disposable.dispose()));
}
