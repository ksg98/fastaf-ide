import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsTransport } from "../components/Terminal/canvasTerminalTransport";
import { decodeBinaryFrame, rowText } from "../components/Terminal/canvasTerminalUtils";
import { DEFLATE_SUBPROTOCOL } from "../components/Terminal/wsFrameCodec";
import { setRemoteBaseUrlLookup, setRemoteTokenLookup } from "../transportRuntime";

vi.mock("../transport", () => ({ isTauri: () => false, rpc: vi.fn().mockResolvedValue(undefined) }));

const recording = readFileSync("src/__tests__/fixtures/remote-idle-grid-1421.bin");
const replay = Uint8Array.from(recording).buffer;

class Socket {
	static instances: Socket[] = [];
	binaryType = "";
	protocol = "";
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
	constructor(_url: string) {
		Socket.instances.push(this);
	}
	close() {
		this.onclose?.();
	}
}

describe("remote terminal replay health", () => {
	let transport: WsTransport;
	beforeEach(() => {
		vi.useFakeTimers();
		Socket.instances = [];
		vi.stubGlobal("WebSocket", Socket);
		setRemoteBaseUrlLookup(() => "http://fixture.test:9877");
		setRemoteTokenLookup(() => "fixture-token");
		transport = new WsTransport("remote-idle", "fixture");
	});
	afterEach(() => {
		transport.unsubscribe();
		setRemoteBaseUrlLookup(() => undefined);
		setRemoteTokenLookup(() => undefined);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	// Catches: the explicit empty replay is mistaken for a stalled healthy idle terminal.
	it.each([false, true])("accepts an empty replay without false failure (negotiated=%s)", async (negotiated) => {
		const errors: unknown[] = [];
		const painted = vi.fn();
		transport.onStreamError((error) => errors.push(error));
		const subscribed = transport.subscribe(painted);
		const socket = Socket.instances[0];
		socket.protocol = negotiated ? DEFLATE_SUBPROTOCOL : "";
		socket.onopen?.();
		await subscribed;
		const text = JSON.stringify({ type: "grid-replay-empty" });
		const data = negotiated ? new Uint8Array([2, ...new TextEncoder().encode(text)]).buffer : text;
		socket.onmessage?.({ data });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toEqual([]);
		expect(painted).not.toHaveBeenCalled();
		expect(Socket.instances).toHaveLength(1);
		socket.onmessage?.({ data: negotiated ? new Uint8Array([0, ...new Uint8Array(replay)]).buffer : replay });
		await vi.advanceTimersByTimeAsync(0);
		expect(painted).toHaveBeenCalledTimes(1);
	});

	// Catches: opening a WS is treated as healthy even when initial replay never arrives, leaving a blank pane forever.
	it("reports a stalled attach and replays the existing remote viewport after reconnect without new PTY output", async () => {
		const errors: unknown[] = [];
		const painted: string[] = [];
		const historySizes: number[] = [];
		await transport.onEvent("stream-error", (error) => errors.push(error));
		const subscribed = transport.subscribe((bytes) => {
			const frame = decodeBinaryFrame(bytes);
			if (frame) {
				historySizes.push(frame.historySize);
				painted.push(...frame.rows.map(rowText));
			}
		});
		Socket.instances[0].onopen?.();
		await subscribed;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("initial terminal frame");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(Socket.instances).toHaveLength(2);
		Socket.instances[1].onopen?.();
		Socket.instances[1].onmessage?.({ data: replay });
		expect(historySizes).toHaveLength(1);
		expect(historySizes).toEqual([0]); // This recording is the idle viewport, not scrollback.
		expect(painted.join("\n")).toContain("~/Gits/personal");
		expect(painted.join("\n")).toContain("❯");
		// Healthy idle terminals owe no subsequent output; a watchdog on silence would report a false failure.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toHaveLength(1);
	});

	// Catches: a socket lost after opening never rejects subscribe, so the persistent-error consumer hears nothing.
	it("reports an unexpected close after healthy replay but stays silent on intentional teardown", async () => {
		const errors: unknown[] = [];
		await transport.onEvent("stream-error", (error) => errors.push(error));
		const subscribed = transport.subscribe(() => {});
		Socket.instances[0].onopen?.();
		await subscribed;
		Socket.instances[0].onmessage?.({ data: replay });
		Socket.instances[0].onclose?.();
		expect(errors).toHaveLength(1);
		transport.unsubscribe();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toHaveLength(1);
		expect(Socket.instances).toHaveLength(1);
	});

	// Catches: a compressed replay decoding failure only warns and leaves an open socket feeding no renderer.
	it("reports an undecodable negotiated replay instead of silently leaving the canvas blank", async () => {
		const errors: unknown[] = [];
		await transport.onEvent("stream-error", (error) => errors.push(error));
		const subscribed = transport.subscribe(() => {});
		Socket.instances[0].protocol = DEFLATE_SUBPROTOCOL;
		Socket.instances[0].onopen?.();
		await subscribed;
		Socket.instances[0].onmessage?.({ data: new Uint8Array([0x7f]).buffer });
		await vi.advanceTimersByTimeAsync(0);
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("unknown WebSocket frame tag");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(Socket.instances).toHaveLength(2);
		Socket.instances[1].onopen?.();
		Socket.instances[1].onmessage?.({ data: replay });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(Socket.instances).toHaveLength(2);
		expect(errors).toHaveLength(1);
	});
	// Catches: successful handshakes reset retry attempts even though no replay arrived, creating an infinite reconnect loop.
	it("bounds retries when each reopened socket closes before replay", async () => {
		const subscribed = transport.subscribe(() => {});
		Socket.instances[0].onopen?.();
		await subscribed;
		for (let attempt = 0; attempt <= 10; attempt++) {
			const socket = Socket.instances[attempt];
			socket.onopen?.();
			socket.onclose?.();
			await vi.advanceTimersByTimeAsync(32_000);
		}
		expect(Socket.instances).toHaveLength(11);
	});

	// Catches: a canceled initial-replay watchdog wakes after unmount and raises a false failure or opens an orphan socket.
	it("cancels the replay deadline when an attached terminal unmounts", async () => {
		const errors: unknown[] = [];
		await transport.onEvent("stream-error", (error) => errors.push(error));
		const subscribed = transport.subscribe(() => {});
		Socket.instances[0].onopen?.();
		await subscribed;
		transport.unsubscribe();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(errors).toEqual([]);
		expect(Socket.instances).toHaveLength(1);
	});
});
