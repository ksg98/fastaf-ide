/**
 * WebSocket bridges for the high-frequency AI token streams in browser/PWA mode
 * (event-bridge plan Step 5). Browser parity for the desktop Tauri `Channel`
 * transport of `start_conversation`: the backend WS handler in
 * `src-tauri/src/mcp_http/ai_stream.rs` emits byte-identical frames, so the same
 * store handler (`applyConversationEvent`) consumes them.
 *
 * The chat-registry counterpart (`chat_subscribe`, `/ai/chat/{id}/stream`) had a
 * client here too. It was removed with its consumer: the registry has no
 * producer, so the stream only ever delivered an empty snapshot, and applying it
 * wiped the history just read from disk. Restore it only together with a
 * producer.
 */

/** Build a ws(s):// URL for the current origin (mirrors the PTY stream WS). */
export function aiWsUrl(path: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}${path}`;
}

/** Start params sent as the first frame of a conversation stream — mirrors the
 * `start_conversation` Tauri command args (minus `sessionId`/`onEvent`). */
export interface ConversationStreamParams {
	message: string;
	autonomy?: "assisted" | "autonomous";
	maxSteps?: number;
	temperature?: number;
	modelOverride?: string;
	bypassedTools?: string[];
	reasoningEffort?: string;
}

/** Lifecycle hooks for a JSON stream. `onClose(clean)` fires exactly once when
 * the socket errors or is closed by the server — NOT when we dispose it. `clean`
 * is true only for a normal close (code 1000); a server that just drops the
 * socket after the terminal frame reports `clean=false`, so callers must guard
 * against surfacing a spurious error after a Completed/Error event. */
interface JsonStreamHooks {
	onOpen?: (ws: WebSocket) => void;
	onClose?: (clean: boolean) => void;
}

/** Open a WebSocket, dispatch each JSON frame to `onEvent`, and return a disposer
 * that closes it. `onOpen` runs once the socket is ready (used to send params);
 * `onClose` fires on an unsolicited error/close so the caller can reset state. */
function openJsonStream<T>(url: string, onEvent: (event: T) => void, hooks?: JsonStreamHooks): () => void {
	const ws = new WebSocket(url);
	let settled = false; // guards onClose to fire once, and never after dispose()
	if (hooks?.onOpen) ws.onopen = () => hooks.onOpen!(ws);
	ws.onmessage = (e) => {
		try {
			onEvent(JSON.parse(e.data as string) as T);
		} catch {
			/* ignore a malformed frame; keep the stream alive */
		}
	};
	const settle = (clean: boolean) => {
		if (settled) return;
		settled = true;
		hooks?.onClose?.(clean);
	};
	ws.onerror = () => settle(false);
	ws.onclose = (e) => settle(e.code === 1000);
	return () => {
		settled = true; // our own close — not an error to report
		try {
			ws.close();
		} catch {
			/* already closing/closed */
		}
	};
}

/**
 * Open the conversation token-stream WS (browser parity for the desktop
 * `start_conversation` Channel). Sends `params` as the first frame, then invokes
 * `onEvent` for each `ConversationEvent`. `onClose` fires if the socket drops
 * unexpectedly. Returns a disposer that closes the WS.
 */
export function openConversationStream<T>(
	sessionId: string,
	params: ConversationStreamParams,
	onEvent: (event: T) => void,
	onClose?: (clean: boolean) => void,
): () => void {
	return openJsonStream<T>(aiWsUrl(`/ai/conversation/${encodeURIComponent(sessionId)}/stream`), onEvent, {
		onOpen: (ws) => ws.send(JSON.stringify(params)),
		onClose,
	});
}
