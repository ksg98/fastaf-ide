/**
 * The "clear" shortcut belongs to whatever holds the keyboard.
 *
 * Cmd/Ctrl+K is the terminal's Clear Scrollback: a native menu accelerator and a
 * keybinding, both of which act on the active terminal wherever the focus is.
 * With the keyboard in AI Chat that wiped the terminal next to the chat the
 * user meant. The terminal's handler asks here first; when the focus is in AI
 * Chat the request goes to the panel, which clears its transcript view (saved
 * history untouched), and the terminal is left alone.
 */

/** Fired on `window`: the docked AI Chat panel clears its transcript view. */
export const CLEAR_CHAT_VIEW_EVENT = "fastaf:ai-chat-clear-view";

/** True when the keyboard focus is inside the AI Chat panel. */
export function aiChatHasFocus(): boolean {
	return !!document.activeElement?.closest('[data-focus-target="ai-chat"]');
}

/** Hand a "clear" to AI Chat when it has the keyboard. Returns true when it took it. */
export function routeClearToAiChat(): boolean {
	if (!aiChatHasFocus()) return false;
	window.dispatchEvent(new CustomEvent(CLEAR_CHAT_VIEW_EVENT));
	return true;
}
