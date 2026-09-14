import { appLogger } from "../../stores/appLogger";
import { isTauri, rpc } from "../../transport";
import { isPerfDebug } from "../../utils/perfDebug";

export interface TerminalTransport {
	subscribe(onFrame: (data: ArrayBuffer) => void): Promise<void>;
	resubscribe(): Promise<void>;
	unsubscribe(): void;
	invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
	/**
	 * Report the total number of frames received, opening the backend's delivery
	 * gate once the count catches up with what it sent.
	 *
	 * Only the Tauri channel is gated this way; the WS transport recovers from a
	 * dropped frame by sequence number and has no ack command at all, so the call
	 * is a no-op there rather than a per-frame rejected invoke.
	 */
	ackFrame(received: number): void;
	onEvent(type: string, handler: (payload: unknown) => void): Promise<void>;
}

/**
 * Normalize a binary IPC payload to an ArrayBuffer, or null when it is not
 * binary at all.
 *
 * Rust hands grid frames and styled-row chunks over as raw bytes, which reach JS
 * as an ArrayBuffer on the custom-protocol IPC and as a plain `number[]` on the
 * postMessage path Tauri falls back to when that protocol is blocked. Both are
 * legitimate; anything else (an error object, null, a string) is not, and must
 * not be fed to `new Uint8Array()` — that quietly produces an empty buffer, so a
 * broken response would decode as an empty frame instead of being dropped.
 */
export function toBinaryPayload(data: unknown): ArrayBuffer | null {
	if (data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) {
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	}
	if (Array.isArray(data)) return new Uint8Array(data).buffer;
	return null;
}

export function createTransport(sessionId: string, baseUrl?: string): TerminalTransport {
	if (baseUrl) return new WsTransport(sessionId, baseUrl);
	return isTauri() ? new TauriTransport(sessionId) : new WsTransport(sessionId);
}

export class TauriTransport implements TerminalTransport {
	private sessionId: string;
	private invokeRef: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
	private unlisteners: (() => void)[] = [];
	private onFrameHandler: ((data: ArrayBuffer) => void) | null = null;
	/**
	 * Epoch of the live subscription, as returned by `subscribe_terminal_grid`,
	 * or null while there is none.
	 *
	 * A terminal that remounts subscribes before the outgoing instance tears
	 * down, so the backend receives the old instance's calls against the new
	 * gate. The epoch is what makes those calls harmless: an ack for a previous
	 * subscription is dropped instead of crediting frames nobody received, and a
	 * stale unsubscribe is dropped instead of deleting the live channel.
	 */
	private epoch: number | null = null;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	async subscribe(onFrame: (data: ArrayBuffer) => void): Promise<void> {
		this.onFrameHandler = onFrame;
		const { invoke, Channel } = await import("@tauri-apps/api/core");
		this.invokeRef = invoke;
		await this.registerChannel(invoke, Channel);
	}

	async resubscribe(): Promise<void> {
		if (!this.onFrameHandler) return;
		const { invoke, Channel } = await import("@tauri-apps/api/core");
		this.invokeRef = invoke;
		await this.registerChannel(invoke, Channel);
	}

	private async registerChannel(
		invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
		Channel: new () => { onmessage: (data: ArrayBuffer | number[]) => void },
	): Promise<void> {
		const onFrame = this.onFrameHandler!;
		const sessionId = this.sessionId;
		const channel = new Channel();
		channel.onmessage = (data: ArrayBuffer | number[]) => {
			const frame = toBinaryPayload(data);
			if (!frame) {
				appLogger.error("terminal", "grid channel delivered a non-binary payload", { sessionId });
				return;
			}
			try {
				onFrame(frame);
			} catch (e) {
				appLogger.error("terminal", "onFrame threw in channel callback", { sessionId, error: e });
			}
		};
		this.epoch = (await invoke("subscribe_terminal_grid", {
			sessionId: this.sessionId,
			channel,
		})) as number;
		invoke("terminal_request_frame", { sessionId: this.sessionId }).catch(() => {});
	}

	unsubscribe(): void {
		if (this.epoch !== null) {
			this.invokeRef?.("unsubscribe_terminal_grid", { sessionId: this.sessionId, epoch: this.epoch }).catch(() => {});
			this.epoch = null;
		}
		for (const unlisten of this.unlisteners) {
			// Tauri's unlisten is async under the hood and REJECTS if its internal
			// registry entry is already gone (webview/session teardown race — common
			// now that a shell exit disposes the terminal). Teardown must swallow it,
			// not surface an unhandled rejection.
			Promise.resolve(unlisten() as unknown).catch(() => {});
		}
		this.unlisteners = [];
	}

	async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.invokeRef) {
			const { invoke } = await import("@tauri-apps/api/core");
			this.invokeRef = invoke;
		}
		return this.invokeRef(cmd, args);
	}

	ackFrame(received: number): void {
		// No epoch means no live subscription: there is no gate to open, and epoch 0
		// would match none, so the backend would ignore every later ack anyway.
		if (this.epoch === null) return;
		this.invokeRef?.("ack_terminal_frame", { sessionId: this.sessionId, epoch: this.epoch, received }).catch((e) => {
			appLogger.debug("terminal", "ack_terminal_frame failed", { sessionId: this.sessionId, error: e });
		});
	}

	async onEvent(type: string, handler: (payload: unknown) => void): Promise<void> {
		const { listen } = await import("@tauri-apps/api/event");
		const eventName = `pty-${type}-${this.sessionId}`;
		const unlisten = await listen(eventName, (event: { payload: unknown }) => {
			handler(event.payload);
		});
		this.unlisteners.push(unlisten);
	}
}

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_MS = 1000;

export class WsTransport implements TerminalTransport {
	private sessionId: string;
	private baseUrl: string | undefined;
	private ws: WebSocket | null = null;
	private onFrameHandler: ((data: ArrayBuffer) => void) | null = null;
	private eventHandlers = new Map<string, (payload: unknown) => void>();
	private closed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;

	constructor(sessionId: string, baseUrl?: string) {
		this.sessionId = sessionId;
		this.baseUrl = baseUrl;
	}

	async subscribe(onFrame: (data: ArrayBuffer) => void): Promise<void> {
		this.onFrameHandler = onFrame;
		this.closed = false;
		this.reconnectAttempts = 0;
		await this.connect();
	}

	async resubscribe(): Promise<void> {
		this.closed = false;
		this.reconnectAttempts = 0;
		this.ws?.close();
		this.ws = null;
		await this.connect();
	}

	private async connect(): Promise<void> {
		let url: string;
		if (this.baseUrl) {
			// Remote: convert http(s) baseUrl to ws(s)
			const wsBase = this.baseUrl.replace(/^http/, "ws");
			url = `${wsBase}/sessions/${encodeURIComponent(this.sessionId)}/stream?format=grid`;
		} else {
			// Local: use current page origin
			const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
			url = `${proto}//${window.location.host}/sessions/${encodeURIComponent(this.sessionId)}/stream?format=grid`;
		}
		// Every handler below is guarded on `this.ws === ws`. A socket the transport
		// has moved on from still fires its callbacks: its onclose reads as an
		// unexpected drop and reconnects a socket nobody tracks, and its onmessage
		// feeds deltas from an older stream into the same row map — an old delta
		// landing after a newer full frame paints stale rows with no error.
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.binaryType = "arraybuffer";
		ws.onmessage = (e) => {
			if (this.ws !== ws) return;
			if (e.data instanceof ArrayBuffer) {
				this.onFrameHandler?.(e.data);
			} else {
				try {
					const event = JSON.parse(e.data as string) as { type: string; [key: string]: unknown };
					const { type, ...payload } = event;
					this.eventHandlers.get(type)?.(payload);
				} catch (err) {
					if (isPerfDebug()) {
						appLogger.debug("terminal", "WsTransport received an unparseable text frame", {
							sessionId: this.sessionId,
							frameStart: (e.data as string)?.slice?.(0, 100),
							error: err,
						});
					}
				}
			}
		};
		ws.onclose = () => {
			if (this.closed || this.ws !== ws) return;
			if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
				appLogger.warn("terminal", `Terminal stream disconnected after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`, {
					sessionId: this.sessionId,
				});
				return;
			}
			const delay = INITIAL_RECONNECT_MS * 2 ** Math.min(this.reconnectAttempts, 5);
			this.reconnectAttempts++;
			this.reconnectTimer = setTimeout(() => {
				this.connect()
					.then(() => {
						this.reconnectAttempts = 0;
					})
					.catch((err) => {
						if (isPerfDebug()) {
							appLogger.debug("terminal", "WsTransport reconnect failed", { sessionId: this.sessionId, error: err });
						}
					});
			}, delay);
		};
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("WebSocket connection failed"));
		});
	}

	unsubscribe(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this.eventHandlers.clear();
	}

	async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
		return rpc(cmd, args);
	}

	ackFrame(_received: number): void {
		// No-op by design. `ack_terminal_frame` is desktop-only; this socket's
		// backend detects a dropped frame from the sequence number it stamps on
		// each one and resends the full grid, so there is nothing to acknowledge.
	}

	onEvent(type: string, handler: (payload: unknown) => void): Promise<void> {
		this.eventHandlers.set(type, handler);
		return Promise.resolve();
	}
}
