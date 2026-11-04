/**
 * The client half of `src-tauri/src/mcp_http/ws_compression.rs`.
 *
 * A stream WebSocket opened with `?compress=deflate` carries every frame as a
 * binary message whose first byte names what the rest is. The tag exists
 * because a deflated payload is not UTF-8, so a compressed text frame has to
 * travel as binary — and a frame whose WebSocket type changed with its size
 * would leave the reader guessing. The byte says it instead.
 *
 * Nothing here is reached on a socket that did not ask: that socket carries the
 * original framing and this module is never called.
 */

/**
 * The subprotocol this client offers when it asks for compression, and the only
 * thing that tells it the request was heard.
 *
 * Must match `mcp_http::ws_compression::DEFLATE_SUBPROTOCOL`. A server that does
 * not know it leaves `ws.protocol` empty, and a browser fails a socket whose
 * server selects a subprotocol that was never offered — so there is no third
 * answer to get wrong.
 */
export const DEFLATE_SUBPROTOCOL = "tuic.deflate";

/** Must match `mcp_http::ws_compression::FrameTag` value for value. */
export const FRAME_TAG = {
	binary: 0x00,
	binaryDeflate: 0x01,
	text: 0x02,
	textDeflate: 0x03,
} as const;

export type DecodedFrame = { kind: "binary"; data: ArrayBuffer } | { kind: "text"; data: string };

const textDecoder = new TextDecoder();

/**
 * Whether this runtime can read a deflated frame.
 *
 * Asking for an encoding we cannot decode would break the terminal rather than
 * slow it down, so the request is made only when this is true. `DecompressionStream`
 * is the platform's own inflate — no bundled one, and no second implementation
 * to keep in step with the server.
 */
export function canDecodeDeflate(): boolean {
	return typeof DecompressionStream === "function";
}

/** Inflate one raw-deflate block — what `flate2::Compress::new(level, false)` wrote. */
async function inflate(body: Uint8Array): Promise<ArrayBuffer> {
	const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return await new Response(stream).arrayBuffer();
}

/**
 * Read one frame off a negotiated socket.
 *
 * Rejects on an unknown tag rather than guessing: the only way to get one is a
 * server newer than this client, and rendering its payload as a grid delta
 * would paint garbage with no error.
 */
export async function decodeTaggedFrame(frame: ArrayBuffer): Promise<DecodedFrame> {
	const view = new Uint8Array(frame);
	if (view.length === 0) {
		throw new Error("tagged WebSocket frame is empty");
	}
	const body = view.subarray(1);
	switch (view[0]) {
		case FRAME_TAG.binary:
			// `slice` and not `buffer`: the view starts one byte in, and handing
			// on the whole buffer would give the reader the tag back as grid data.
			return { kind: "binary", data: body.slice().buffer };
		case FRAME_TAG.binaryDeflate:
			return { kind: "binary", data: await inflate(body) };
		case FRAME_TAG.text:
			return { kind: "text", data: textDecoder.decode(body) };
		case FRAME_TAG.textDeflate:
			return { kind: "text", data: textDecoder.decode(await inflate(body)) };
		default:
			throw new Error(`unknown WebSocket frame tag 0x${view[0].toString(16).padStart(2, "0")}`);
	}
}
