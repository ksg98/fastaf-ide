import { createEffect, onCleanup } from "solid-js";
import { registerAiChatContextActions } from "../components/AIChatPanel/contextMenuActions";
import { contextMenuActionsStore } from "../stores/contextMenuActionsStore";
import { conversationStore } from "../stores/conversationStore";
import { promptLibraryStore, type SavedPrompt } from "../stores/promptLibrary";
import { settingsStore } from "../stores/settings";
import { uiStore } from "../stores/ui";
import { runWithFeedback } from "../utils/promptContext";
import type { SmartPromptResult } from "./useSmartPrompts";

interface PluginContextActionOptions {
	executeSmartPrompt: (prompt: SavedPrompt, manualVariables?: Record<string, string>) => Promise<SmartPromptResult>;
	canExecute: (prompt: SavedPrompt) => { ok: boolean };
}

/** Owns context-action registration lifecycles for built-in prompt and AI integrations. */
export function usePluginContextActions(options: PluginContextActionOptions): void {
	// The AI Chat entries exist only while the panel they open does: an entry
	// that opens a panel the user cannot see is a dead end. Turning the chat
	// off also closes a panel left open.
	createEffect(() => {
		if (!settingsStore.isAiChatEnabled()) {
			if (uiStore.state.aiChatPanelVisible) uiStore.setAiChatPanelVisible(false);
			return;
		}
		const disposables = registerAiChatContextActions();
		void conversationStore.initFromDisk();
		onCleanup(() => disposables.forEach((disposable) => disposable.dispose()));
	});

	createEffect(() => {
		const disposables: Array<{ dispose(): void }> = [];
		for (const prompt of promptLibraryStore.getSmartByPlacement("git-branches")) {
			disposables.push(
				contextMenuActionsStore.registerContextAction("smart-prompts", {
					id: `smart:${prompt.id}`,
					label: prompt.name,
					target: "branch",
					action: (context) => {
						void runWithFeedback(prompt, () =>
							options.executeSmartPrompt(prompt, context.branchName ? { branch_name: context.branchName } : undefined),
						);
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
						void runWithFeedback(prompt, () => options.executeSmartPrompt(prompt));
					},
					disabled: () => !options.canExecute(prompt).ok,
				}),
			);
		}
		onCleanup(() => disposables.forEach((disposable) => disposable.dispose()));
	});
}
