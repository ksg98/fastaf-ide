/**
 * The frame producer for one ACP connection, on whichever transport this host
 * has.
 *
 * Two transports, one payload: the desktop Tauri `Channel` and the browser
 * WebSocket carry the same `AcpStreamFrame` JSON, so everything above this file
 * is written once. The path is not spelled here — `DEDICATED_WS_COMMANDS` in
 * `transport.ts` owns it, next to the HTTP routes, so a route rename moves one
 * line rather than two.
 *
 * Nothing here decides what to do with a frame or whether to open another
 * stream. A gap is delivered, not acted on; a socket that drops is reported,
 * not retried. Those are one decision about one journal cursor and they live in
 * `acpClient`, which holds the cursor.
 */

import { appLogger } from "../stores/appLogger";
import { DEDICATED_WS_COMMANDS, isTauri } from "../transport";
import type { AcpStreamFrame } from "../types/acp";

/** A live subscription. Closing it twice is safe and does nothing the second time. */
export interface AcpStreamHandle {
	close(): void;
}

export interface AcpStreamOptions {
	connectionId: string;
	/** The first sequence to deliver. `subscribe` delivers `>= from`. */
	afterSequence: number;
	onFrame: (frame: AcpStreamFrame) => void;
	/**
	 * The stream stopped without a terminal frame.
	 *
	 * Only the WebSocket can report this: a Tauri `Channel` has no close event,
	 * so on the desktop the producer's own `end` or `gap` is the only ending
	 * there is. A caller that treats this as "maybe more is coming" is right on
	 * both transports.
	 */
	onDropped?: () => void;
}

/** Open the frame stream for one connection. */
export type AcpStreamOpener = (options: AcpStreamOptions) => Promise<AcpStreamHandle>;

export const openAcpStream: AcpStreamOpener = (options) => (isTauri() ? openChannel(options) : openSocket(options));

async function openChannel({ connectionId, afterSequence, onFrame }: AcpStreamOptions): Promise<AcpStreamHandle> {
	const { invoke, Channel } = await import("@tauri-apps/api/core");
	const channel = new Channel<AcpStreamFrame>();
	let closed = false;
	channel.onmessage = (frame) => {
		if (closed) return;
		onFrame(frame);
	};
	await invoke("acp_subscribe", { connectionId, afterSequence, channel });
	return {
		close() {
			// The producer stops when the journal ends or the connection settles;
			// there is no unsubscribe command, so dropping the callback is what
			// closing means here. Frames already queued are discarded rather than
			// applied to a store the caller has moved on from.
			closed = true;
		},
	};
}

function socketUrl(connectionId: string, afterSequence: number): string {
	const path = DEDICATED_WS_COMMANDS.get("acp_subscribe")?.({ connectionId, afterSequence });
	if (!path) throw new Error("acp_subscribe has no WebSocket path; transport.ts and acpStream disagree");
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}${path}`;
}

function openSocket({ connectionId, afterSequence, onFrame, onDropped }: AcpStreamOptions): Promise<AcpStreamHandle> {
	const socket = new WebSocket(socketUrl(connectionId, afterSequence));
	let closed = false;
	const handle: AcpStreamHandle = {
		close() {
			closed = true;
			socket.close();
		},
	};

	socket.onmessage = (event) => {
		if (closed) return;
		try {
			onFrame(JSON.parse(event.data as string) as AcpStreamFrame);
		} catch (error) {
			// A frame that does not parse is not a frame this client can act on,
			// and guessing at it would put a made-up event in the journal. Report
			// it and carry on: the next one may be fine, and the sequence the
			// store holds is unchanged, so a later resume asks for this one again.
			appLogger.error("ai-chat", "stream delivered an unparseable frame", { connectionId, error });
		}
	};
	socket.onclose = () => {
		if (closed) return;
		closed = true;
		onDropped?.();
	};

	return new Promise((resolve, reject) => {
		socket.onopen = () => resolve(handle);
		socket.onerror = () => {
			// A socket that never opened reports its failure once, as a rejected
			// open. Leaving it to the close handler as well would tell the caller
			// both that the stream could not start and that a live one dropped,
			// and the second of those would start a resume from a cursor nothing
			// had moved.
			if (socket.readyState !== WebSocket.OPEN) closed = true;
			reject(new Error(`ACP stream for ${connectionId} failed to open`));
		};
	});
}
