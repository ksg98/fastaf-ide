import { describe, expect, it } from "vitest";

import { decodeTaggedFrame, FRAME_TAG } from "../wsFrameCodec";

/** Deflate the way `flate2::Compress::new(level, false)` does: a raw block, no zlib wrapper. */
async function deflate(payload: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([payload as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function frame(tag: number, body: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(body.length + 1);
	out[0] = tag;
	out.set(body, 1);
	return out.buffer;
}

describe("wsFrameCodec", () => {
	// The tag numbers are a wire contract with `mcp_http::ws_compression::FrameTag`.
	// Reading them off the enum on either side would let both drift together and
	// still pass; the literals are the point.
	it("names the four tags the server writes", () => {
		expect(FRAME_TAG).toEqual({ binary: 0x00, binaryDeflate: 0x01, text: 0x02, textDeflate: 0x03 });
	});

	it("returns an identity payload without its tag", async () => {
		const decoded = await decodeTaggedFrame(frame(FRAME_TAG.binary, new Uint8Array([1, 2, 3])));

		expect(decoded.kind).toBe("binary");
		expect(new Uint8Array(decoded.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("inflates a deflated payload back to what the server serialised", async () => {
		const grid = new Uint8Array(8192).fill(0x2e);
		const decoded = await decodeTaggedFrame(frame(FRAME_TAG.binaryDeflate, await deflate(grid)));

		expect(new Uint8Array(decoded.data as ArrayBuffer)).toEqual(grid);
	});

	it("gives a text frame back as a string, compressed or not", async () => {
		const json = '{"type":"exit","session_id":"s1"}';
		const bytes = new TextEncoder().encode(json);

		await expect(decodeTaggedFrame(frame(FRAME_TAG.text, bytes))).resolves.toEqual({ kind: "text", data: json });
		await expect(decodeTaggedFrame(frame(FRAME_TAG.textDeflate, await deflate(bytes)))).resolves.toEqual({
			kind: "text",
			data: json,
		});
	});

	// The only way to see one is a server newer than this client. Rendering its
	// payload as a grid delta would paint garbage and report nothing.
	it("refuses a tag it does not know instead of guessing", async () => {
		await expect(decodeTaggedFrame(frame(0x7f, new Uint8Array([1])))).rejects.toThrow(
			"unknown WebSocket frame tag 0x7f",
		);
	});

	it("refuses a frame with no tag at all", async () => {
		await expect(decodeTaggedFrame(new ArrayBuffer(0))).rejects.toThrow("empty");
	});

	// A tagged frame can legitimately carry nothing after the tag — the server
	// tags every frame on a negotiated socket, including a zero-length one.
	it("reads a tag with an empty payload as an empty payload", async () => {
		const decoded = await decodeTaggedFrame(frame(FRAME_TAG.binary, new Uint8Array(0)));

		expect(new Uint8Array(decoded.data as ArrayBuffer)).toHaveLength(0);
	});
});
