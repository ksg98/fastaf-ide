import { emitTo } from "@tauri-apps/api/event";
import { type Component, lazy, onCleanup, onMount, Suspense } from "solid-js";
import type { AIChatTerminalBinding } from "../components/AIChatPanel/AIChatPanel";
import { openChatTableDocument } from "../components/AIChatPanel/tableDocument";
import { initPanelWindow } from "../hooks/initPanelWindow";
import { useDictation } from "../hooks/useDictation";
import { useDictationHotkey } from "../hooks/useDictationHotkey";
import { invoke } from "../invoke";
import type { PanelAdapter } from "../panelRouter";
import { appLogger } from "../stores/appLogger";
import { conversationStore } from "../stores/conversationStore";
import { dictationStore } from "../stores/dictation";
import { terminalsStore } from "../stores/terminals";
import { uiStore } from "../stores/ui";
import { openTerminalFilePath } from "../utils/filePreview";

const AIChatPanel = lazy(() =>
	import("../components/AIChatPanel/AIChatPanel").then((module) => ({ default: module.AIChatPanel })),
);

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

	// Each WebView owns its DOM and captured target. Main-window hooks cannot
	// insert into this composer, even though both windows share the microphone.
	const dictation = useDictation({
		fallbackInput: () => document.querySelector<HTMLTextAreaElement>("#ai-chat-panel textarea"),
		pty: {
			write: async () => {
				throw new Error("Detached AI Chat has no PTY");
			},
		},
		dictation: dictationStore,
		setStatusInfo: (message) => appLogger.info("dictation", message),
		openSettings: () => {
			void emitTo("main", "panel-action", { panelId: "ai-chat", action: "configure-dictation", data: {} })
				.then(() => invoke("focus_main_window"))
				.catch((error) => appLogger.error("dictation", "Failed to open Voice settings", error));
		},
	});
	useDictationHotkey({
		onStart: () => void dictation.handleDictationStart(dictationStore.state.hotkey === "Fn" ? "fn" : "hotkey"),
		onStop: dictation.handleDictationStop,
	});

	onMount(() => {
		void initPanelWindow();
		void dictationStore.refreshConfig();
		onCleanup(dictationStore.startRemoteSync());
		// Best effort: a missing conversation is swallowed inside the store, so
		// an unknown id just opens an empty chat under that id.
		if (chatId) void conversationStore.loadConversation(chatId);
	});

	return (
		<Suspense>
			<AIChatPanel visible={true} onClose={() => window.close()} terminal={binding} />
		</Suspense>
	);
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
	onDetach: () => uiStore.setAiChatPanelVisible(false),
	handleAction: (action, data) => {
		if (
			action === "open-table" &&
			data &&
			typeof data === "object" &&
			"source" in data &&
			typeof data.source === "string"
		) {
			openChatTableDocument(data.source);
			return;
		}
		if ((action !== "open-file" && action !== "open-directory") || !data || typeof data !== "object") return;
		const { path, line, col } = data as { path?: unknown; line?: unknown; col?: unknown };
		if (typeof path !== "string" || !path) return;
		if (action === "open-directory") {
			uiStore.setFileBrowserExternalRoot(path);
			uiStore.setFileBrowserPanelVisible(true);
			return;
		}
		if (line !== undefined && (!Number.isInteger(line) || Number(line) < 1)) return;
		if (col !== undefined && (!Number.isInteger(col) || Number(col) < 1)) return;
		if (line !== undefined) openTerminalFilePath(path, undefined, line as number, col as number | undefined);
		else openTerminalFilePath(path);
	},
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
