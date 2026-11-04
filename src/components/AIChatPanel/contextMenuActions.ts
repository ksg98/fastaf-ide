/**
 * AI Chat context menu actions — "Explain with AI" and "Fix this error"
 * registered on terminal right-click.
 *
 * FastAF's chat is bound to a terminal, so both send the question straight to
 * the conversation of the terminal that was right-clicked.
 */

import { appLogger } from "../../stores/appLogger";
import { contextMenuActionsStore } from "../../stores/contextMenuActionsStore";
import { conversationStore } from "../../stores/conversationStore";
import { terminalsStore } from "../../stores/terminals";
import { uiStore } from "../../stores/ui";
import { switchToTerminalBySession } from "../../utils/switchToTerminalBySession";

const PLUGIN_ID = "ai-chat";
const MAX_CHARS = 2000;

/** Cut text to `maxChars`, saying so where it was cut. */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... truncated]`;
}

/**
 * The output to ask about: what is selected, or the tail of the screen.
 *
 * The selection comes off the terminal rather than off the document: the grid
 * is drawn on a canvas, so a highlighted region is not a DOM selection and
 * `window.getSelection()` returns nothing for it.
 */
async function terminalText(sessionId?: string): Promise<string> {
	if (!sessionId) return "";
	const entry = Object.values(terminalsStore.state.terminals).find((terminal) => terminal.sessionId === sessionId);
	const selected = entry?.ref?.getSelection().trim();
	if (selected) return selected;
	if (!entry?.ref) return "";
	try {
		const lines = await entry.ref.getBufferLines(0, 999_999);
		return lines.slice(-50).join("\n").trimEnd();
	} catch (error) {
		appLogger.warn("ai-chat", "Failed to read terminal buffer", { error: String(error) });
		return "";
	}
}

/** Open the panel on the right-clicked terminal and send a question about its output. */
async function ask(sessionId: string | undefined, question: (output: string) => string): Promise<void> {
	const raw = await terminalText(sessionId);
	if (!raw) {
		appLogger.info("ai-chat", "No terminal text to ask about");
		return;
	}
	uiStore.setAiChatPanelVisible(true);
	if (sessionId) switchToTerminalBySession(sessionId);
	conversationStore.sendMessage(question(truncateText(raw, MAX_CHARS)), sessionId ?? null);
}

export function registerAiChatContextActions(): Array<{ dispose(): void }> {
	return [
		contextMenuActionsStore.registerContextAction(PLUGIN_ID, {
			id: "ai-chat:explain",
			label: "Explain with AI",
			target: "terminal",
			action: async (context) => {
				await ask(context.sessionId, (output) => `Explain this terminal output:\n\n\`\`\`\n${output}\n\`\`\``);
			},
		}),
		contextMenuActionsStore.registerContextAction(PLUGIN_ID, {
			id: "ai-chat:fix-error",
			label: "Fix this error",
			target: "terminal",
			action: async (context) => {
				await ask(
					context.sessionId,
					(output) =>
						`Analyze this terminal error and suggest a fix:\n\n\`\`\`\n${output}\n\`\`\`\n\n` +
						"Explain: 1) What went wrong 2) The root cause 3) How to fix it",
				);
			},
		}),
	];
}
