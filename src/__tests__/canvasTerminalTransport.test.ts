import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => {
	const mockChannel = class {
		onmessage: ((data: unknown) => void) | null = null;
		id = 1;
	};
	return {
		invoke: vi.fn().mockResolvedValue(undefined),
		Channel: mockChannel,
	};
});

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

// Mock transport for isTauri
vi.mock("../transport", () => ({
	isTauri: vi.fn().mockReturnValue(true),
	rpc: vi.fn().mockResolvedValue(undefined),
}));

import {
	createTransport,
	TauriTransport,
	toBinaryPayload,
	WsTransport,
} from "../components/Terminal/canvasTerminalTransport";
import { isTauri } from "../transport";

describe("canvasTerminalTransport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("createTransport", () => {
		it("returns TauriTransport when isTauri() is true", () => {
			(isTauri as ReturnType<typeof vi.fn>).mockReturnValue(true);
			const t = createTransport("session-1");
			expect(t).toBeInstanceOf(TauriTransport);
		});

		it("returns WsTransport when isTauri() is false", () => {
			(isTauri as ReturnType<typeof vi.fn>).mockReturnValue(false);
			const t = createTransport("session-1");
			expect(t).toBeInstanceOf(WsTransport);
		});
	});

	// Every binary payload the backend sends — grid frames on the channel, styled
	// row chunks from a command — arrives as an ArrayBuffer over the custom-protocol
	// IPC and as a plain number[] over the postMessage fallback Tauri drops to when
	// the custom protocol is blocked. One normalizer covers both callers.
	describe("toBinaryPayload", () => {
		it("passes an ArrayBuffer through untouched", () => {
			const buffer = new Uint8Array([1, 2, 3]).buffer;
			expect(toBinaryPayload(buffer)).toBe(buffer);
		});

		it("packs the postMessage number[] fallback into a buffer", () => {
			const result = toBinaryPayload([26, 0, 255]);
			expect(result).not.toBeNull();
			expect([...new Uint8Array(result!)]).toEqual([26, 0, 255]);
		});

		it("unwraps a Uint8Array view without copying its bytes", () => {
			const view = new Uint8Array([7, 8]);
			expect([...new Uint8Array(toBinaryPayload(view)!)]).toEqual([7, 8]);
		});

		it("rejects a shape that is not binary at all", () => {
			// A command that returns an error object or null must not reach the
			// decoder — `new Uint8Array({})` silently yields an empty buffer, which
			// would read as "an empty chunk" instead of "a broken response".
			expect(toBinaryPayload(undefined)).toBeNull();
			expect(toBinaryPayload(null)).toBeNull();
			expect(toBinaryPayload({ error: "nope" })).toBeNull();
			expect(toBinaryPayload("[1,2,3]")).toBeNull();
		});

		it("keeps an empty payload distinguishable from a broken one", () => {
			// A closed session answers with zero bytes; that is a valid empty chunk.
			expect(toBinaryPayload([])?.byteLength).toBe(0);
		});
	});

	describe("TauriTransport", () => {
		/**
		 * Make `subscribe_terminal_grid` answer with a subscription epoch, the way
		 * the real command does. Every other command keeps resolving undefined.
		 */
		async function mockEpochs(...epochs: number[]): Promise<void> {
			const { invoke } = await import("@tauri-apps/api/core");
			let next = 0;
			(invoke as ReturnType<typeof vi.fn>).mockImplementation((cmd: string) =>
				Promise.resolve(cmd === "subscribe_terminal_grid" ? epochs[Math.min(next++, epochs.length - 1)] : undefined),
			);
		}

		it("subscribes to terminal grid channel via invoke", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			const transport = new TauriTransport("session-1");
			const onFrame = vi.fn();
			await transport.subscribe(onFrame);

			expect(invoke).toHaveBeenCalledWith(
				"subscribe_terminal_grid",
				expect.objectContaining({
					sessionId: "session-1",
				}),
			);
		});

		it("requests initial frame after subscribe", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			const transport = new TauriTransport("session-1");
			await transport.subscribe(vi.fn());

			expect(invoke).toHaveBeenCalledWith("terminal_request_frame", { sessionId: "session-1" });
		});

		it("delegates invoke calls to Tauri invoke", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			(invoke as ReturnType<typeof vi.fn>).mockResolvedValue("result");
			const transport = new TauriTransport("session-1");
			await transport.subscribe(vi.fn());

			const result = await transport.invoke("terminal_scroll", { sessionId: "session-1", delta: 5 });
			expect(invoke).toHaveBeenCalledWith("terminal_scroll", { sessionId: "session-1", delta: 5 });
			expect(result).toBe("result");
		});

		it("acks a frame with the receipt count the gate compares against", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			await mockEpochs(42);
			const transport = new TauriTransport("session-1");
			await transport.subscribe(vi.fn());

			transport.ackFrame(7);
			expect(invoke).toHaveBeenCalledWith("ack_terminal_frame", { sessionId: "session-1", epoch: 42, received: 7 });
		});

		// A remount subscribes before the outgoing instance tears down, so the
		// backend sees the old instance's calls after the new gate is installed.
		// The epoch is what tells them apart: without it a late ack credits frames
		// the new terminal never received, and a late unsubscribe deletes the live
		// channel and leaves a mounted terminal blank.
		it("adopts the epoch of its newest subscription", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			await mockEpochs(42, 43);
			const transport = new TauriTransport("session-1");
			await transport.subscribe(vi.fn());
			await transport.resubscribe();

			transport.ackFrame(3);
			expect(invoke).toHaveBeenCalledWith("ack_terminal_frame", { sessionId: "session-1", epoch: 43, received: 3 });
		});

		it("does not ack before it knows its epoch", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			await mockEpochs(42);
			const transport = new TauriTransport("session-1");

			// A frame cannot arrive before subscribe resolves, but a paint-driven ack
			// racing the very first subscribe must not invent an epoch — epoch 0 would
			// silently match no gate at all, wedging the delivery gate shut forever.
			transport.ackFrame(1);
			expect(invoke).not.toHaveBeenCalledWith("ack_terminal_frame", expect.anything());
		});

		it("registers event listeners via Tauri listen", async () => {
			const { listen } = await import("@tauri-apps/api/event");
			const transport = new TauriTransport("session-1");
			const handler = vi.fn();
			await transport.subscribe(vi.fn());
			await transport.onEvent("cwd", handler);

			expect(listen).toHaveBeenCalledWith("pty-cwd-session-1", expect.any(Function));
		});

		it("calls unsubscribe_terminal_grid with the epoch it owns", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			await mockEpochs(42);
			const transport = new TauriTransport("session-1");
			await transport.subscribe(vi.fn());
			transport.unsubscribe();

			expect(invoke).toHaveBeenCalledWith("unsubscribe_terminal_grid", { sessionId: "session-1", epoch: 42 });
		});

		it("does not unsubscribe a subscription it never made", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			const transport = new TauriTransport("session-1");
			transport.unsubscribe();

			expect(invoke).not.toHaveBeenCalledWith("unsubscribe_terminal_grid", expect.anything());
		});
	});

	describe("WsTransport", () => {
		let wsInstances: MockWebSocket[];

		class MockWebSocket {
			static lastUrl = "";
			binaryType = "";
			onmessage: ((e: { data: unknown }) => void) | null = null;
			onclose: (() => void) | null = null;
			onopen: (() => void) | null = null;
			onerror: ((e: unknown) => void) | null = null;
			close = vi.fn();
			constructor(url: string) {
				MockWebSocket.lastUrl = url;
				wsInstances.push(this);
			}
		}

		beforeEach(() => {
			vi.useFakeTimers();
			wsInstances = [];
			(globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("connects to /sessions/{id}/stream?format=grid", async () => {
			const transport = new WsTransport("sess-42");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			expect(MockWebSocket.lastUrl).toContain("/sessions/sess-42/stream?format=grid");
			expect(wsInstances[0].binaryType).toBe("arraybuffer");
		});

		// `ack_terminal_frame` is desktop-only (INTENTIONALLY_UNMAPPED): calling it
		// over HTTP throws "native/host-only" — once per frame, 30-60 times a second,
		// for a browser client that recovers from dropped frames by sequence number
		// instead. The ack belongs to the transport that has one.
		it("does not ack over HTTP", async () => {
			const { rpc } = await import("../transport");
			const transport = new WsTransport("sess-42");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;
			(rpc as ReturnType<typeof vi.fn>).mockClear();

			transport.ackFrame(7);
			expect(rpc).not.toHaveBeenCalled();
		});

		// resubscribe() closes the old socket while the transport is deliberately NOT
		// in the closed state, so that socket's onclose reads as an unexpected drop
		// and schedules a reconnect — a third socket, on top of the one resubscribe
		// just opened. Both stay live and both feed the same onFrame, so an old delta
		// can land after a newer full frame and paint stale rows over it.
		it("does not let the socket it replaced reconnect behind it", async () => {
			const transport = new WsTransport("sess-42");
			const first = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await first;

			const again = transport.resubscribe();
			wsInstances[1].onopen!();
			await again;
			expect(wsInstances).toHaveLength(2);

			// The close resubscribe asked for finally lands.
			wsInstances[0].onclose!();
			vi.advanceTimersByTime(10_000);
			expect(wsInstances).toHaveLength(2);
		});

		it("ignores frames from a socket it has already replaced", async () => {
			const onFrame = vi.fn();
			const transport = new WsTransport("sess-42");
			const first = transport.subscribe(onFrame);
			wsInstances[0].onopen!();
			await first;

			const again = transport.resubscribe();
			wsInstances[1].onopen!();
			await again;

			wsInstances[0].onmessage!({ data: new Uint8Array([1]).buffer });
			expect(onFrame).not.toHaveBeenCalled();

			wsInstances[1].onmessage!({ data: new Uint8Array([2]).buffer });
			expect(onFrame).toHaveBeenCalledTimes(1);
		});

		it("dispatches binary frames to onFrame handler", async () => {
			const transport = new WsTransport("sess-1");
			const onFrame = vi.fn();
			const subscribePromise = transport.subscribe(onFrame);
			wsInstances[0].onopen!();
			await subscribePromise;

			const buffer = new ArrayBuffer(8);
			wsInstances[0].onmessage!({ data: buffer });
			expect(onFrame).toHaveBeenCalledWith(buffer);
		});

		it("dispatches JSON text messages to event handlers", async () => {
			const transport = new WsTransport("sess-1");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			const handler = vi.fn();
			await transport.onEvent("parsed", handler);

			wsInstances[0].onmessage!({ data: JSON.stringify({ type: "parsed", event: { kind: "cwd" } }) });
			expect(handler).toHaveBeenCalledWith({ event: { kind: "cwd" } });
		});

		// The frames below are byte-for-byte what `grid_ws_frame` serialises in
		// src-tauri/src/mcp_http/session.rs — snake_case `exit_code` included,
		// because the desktop side sends `Osc133Event` and the two must agree.
		// Asserting against a hand-built object would prove nothing about the wire.
		it("delivers an osc133 frame with the field names the Rust event carries", async () => {
			const transport = new WsTransport("sess-1");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			const handler = vi.fn();
			await transport.onEvent("osc133", handler);

			wsInstances[0].onmessage!({
				data: JSON.stringify({ type: "osc133", marker: "D", line: 42, exit_code: 1 }),
			});
			expect(handler).toHaveBeenCalledWith({ marker: "D", line: 42, exit_code: 1 });
		});

		it("delivers a cwd frame as the same { cwd } object the desktop event carries", async () => {
			const transport = new WsTransport("sess-1");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			const handler = vi.fn();
			await transport.onEvent("cwd", handler);

			wsInstances[0].onmessage!({ data: JSON.stringify({ type: "cwd", cwd: "/tmp/work" }) });
			expect(handler).toHaveBeenCalledWith({ cwd: "/tmp/work" });
		});

		it("reconnects on unexpected close", async () => {
			const transport = new WsTransport("sess-1");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			// Simulate unexpected close
			wsInstances[0].onclose!();
			expect(wsInstances).toHaveLength(1);

			// After 1s reconnect timer fires
			vi.advanceTimersByTime(1000);
			expect(wsInstances).toHaveLength(2);

			// Settle the reconnect connect promise to avoid leak
			wsInstances[1].onopen!();
			transport.unsubscribe();
		});

		it("does not reconnect after explicit unsubscribe", async () => {
			const transport = new WsTransport("sess-1");
			const subscribePromise = transport.subscribe(vi.fn());
			wsInstances[0].onopen!();
			await subscribePromise;

			transport.unsubscribe();
			expect(wsInstances[0].close).toHaveBeenCalled();

			vi.advanceTimersByTime(2000);
			expect(wsInstances).toHaveLength(1); // no new instance
		});

		it("delegates invoke to rpc()", async () => {
			const { rpc } = await import("../transport");
			(rpc as ReturnType<typeof vi.fn>).mockResolvedValue("ws-result");
			const transport = new WsTransport("session-1");
			const result = await transport.invoke("resize_pty", { sessionId: "session-1", rows: 24, cols: 80 });

			expect(rpc).toHaveBeenCalledWith("resize_pty", { sessionId: "session-1", rows: 24, cols: 80 });
			expect(result).toBe("ws-result");
		});
	});
});
