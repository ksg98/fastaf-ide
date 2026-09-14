import { type Component, onMount } from "solid-js";
import { AIChatPanel, type AIChatTerminalBinding } from "../components/AIChatPanel/AIChatPanel";
import { initPanelWindow } from "../hooks/initPanelWindow";
import type { PanelAdapter } from "../panelRouter";
import { conversationStore } from "../stores/conversationStore";
import { terminalsStore } from "../stores/terminals";
import { uiStore } from "../stores/ui";

const DetachedAIChatPanel: Component<{ params: URLSearchParams }> = (props) => {
	const chatId = props.params.get("chatId");
	const terminalKey = props.params.get("terminalKey") || null;
	const sessionId = props.params.get("sessionId") || null;
	const terminalName = props.params.get("terminalName") || null;

	// Adopt the terminal BEFORE the chat id. conversationStore keys its state per
	// terminal, so switching terminal afterwards swaps in a fresh empty state and
	// drops both the id and anything loaded into it. It also decides what
	// `persistNow` writes as the conversation's `session_id`: under the default
	// key it writes null, which orphans the conversation from the terminal that
	// owns it, and `initFromDisk` then never finds it again.
	if (terminalKey) conversationStore.setActiveTerminal(terminalKey);

	// `loadConversation` derives the id from the file it reads, so a conversation
	// that has never been saved would leave this window on the id its own store
	// generated — and every message sent from here would land somewhere the main
	// window never opens.
	if (chatId) conversationStore.setChatId(chatId);

	// This window has no terminalsStore of its own, so the terminal it talks to
	// is the one it was opened with. It stays pinned to that terminal for its
	// whole life: following the main window's focus instead would swap the
	// conversation out from under whoever detached it deliberately.
	const binding = (): AIChatTerminalBinding => ({
		sessionId,
		name: terminalName,
		attached: sessionId !== null,
	});

	onMount(() => {
		void initPanelWindow();
		// Best effort: a missing conversation is swallowed inside the store, so
		// an unknown id just opens an empty chat under that id.
		if (chatId) void conversationStore.loadConversation(chatId);
	});

	return <AIChatPanel visible={true} onClose={() => window.close()} terminal={binding} />;
};

/** conversationStore's key for the terminal focused right now, null when none is. */
function activeTerminalKey(): string | null {
	const activeId = terminalsStore.state.activeId;
	if (!activeId) return null;
	return terminalsStore.get(activeId)?.tuicSession ?? activeId;
}

/**
 * Terminal the detached window was handed, remembered so the main window knows
 * whose conversation came back. Set on every open of that window — `detachPanel`
 * and the restore after a restart both go through `detachParams`.
 */
let handedOverKey: string | null = null;

export const aiChatPanelAdapter: PanelAdapter = {
	id: "ai-chat",
	title: "AI Chat",
	defaultSize: { width: 500, height: 700 },
	toggle: () => uiStore.toggleAiChatPanel(),
	detachParams: () => {
		const activeId = terminalsStore.state.activeId;
		const terminal = activeId ? terminalsStore.get(activeId) : undefined;
		handedOverKey = activeId ? (terminal?.tuicSession ?? activeId) : null;
		// Empty string, never "null"/"undefined": URLSearchParams would hand those
		// back as a perfectly valid session id.
		return {
			chatId: conversationStore.chatId(),
			terminalKey: handedOverKey ?? "",
			sessionId: terminal?.sessionId ?? "",
			terminalName: terminal?.name ?? "",
		};
	},
	// Everything typed in the detached window was persisted by ITS store, not
	// this one — the main window's copy of that conversation is frozen at the
	// moment it detached, so coming home has to re-read it.
	//
	// Which conversation, though, depends on where the main window is now. Its
	// `chatId()` follows the FOCUSED terminal, so re-reading that after the user
	// switched terminals would refresh the wrong one and leave the detached
	// terminal stale for good — `initFromDisk` skips a state it has already
	// initialized, so switching back would still show the pre-detach messages.
	//
	// DEFERRED (2026-08-18) — the detached store saves on a 500ms debounce
	// (PERSIST_DEBOUNCE_MS), so closing that window inside 500ms of the last
	// message races this read and the message is lost. Flushing needs a save
	// that survives webview teardown; a `pagehide` handler cannot await the
	// invoke. Left alone: 500ms is far below the time a human takes to read a
	// reply and reach for the close button.
	onReattach: () => {
		const key = handedOverKey;
		handedOverKey = null;
		if (key && key !== activeTerminalKey()) {
			conversationStore.invalidateTerminal(key);
			return;
		}
		void conversationStore.loadConversation(conversationStore.chatId());
	},
	Component: DetachedAIChatPanel,
};
