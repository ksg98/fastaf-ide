import { afterEach, describe, expect, it, vi } from "vitest";
import "./mocks/tauri";
import { subscribePty } from "../transport";
import { setRemoteBaseUrlLookup, setRemoteTokenLookup, setSessionConnectionLookup } from "../transportRuntime";

class Socket {
	static last: Socket;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	close = vi.fn();
	constructor(readonly url: string) {
		Socket.last = this;
	}
	frame(frame: Record<string, unknown>) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	setRemoteBaseUrlLookup(() => undefined);
	setRemoteTokenLookup(() => undefined);
	setSessionConnectionLookup(() => undefined);
});

describe("remote PTY metadata", () => {
	// Catches: desktop remote terminals listen to local IPC and miss all daemon metadata.
	it("delivers owner WS metadata on desktop without treating title or parsed events as activity", async () => {
		vi.stubGlobal("__TAURI_INTERNALS__", {});
		vi.stubGlobal("WebSocket", Socket);
		setSessionConnectionLookup((id) => (id === "remote-1" ? "mint" : undefined));
		setRemoteBaseUrlLookup(() => "https://mint.example");
		setRemoteTokenLookup(() => "test-token");
		const activity = vi.fn(),
			parsed = vi.fn(),
			title = vi.fn(),
			exit = vi.fn();
		const pending = subscribePty("remote-1", vi.fn(), exit, { onActivity: activity, onParsed: parsed, onTitle: title });
		expect(Socket.last?.url).toBe("wss://mint.example/sessions/remote-1/stream?token=test-token");
		Socket.last.onopen?.();
		const subscription = await pending;
		try {
			Socket.last.frame({ type: "title", title: "Claude Code" });
			Socket.last.frame({ type: "title", title: "" });
			Socket.last.frame({ type: "parsed", event: { type: "shell-state", state: "idle" } });
			expect(title.mock.calls).toEqual([["Claude Code"], [""]]);
			expect(parsed).toHaveBeenCalledWith({ type: "parsed", event: { type: "shell-state", state: "idle" } });
			expect(activity).not.toHaveBeenCalled();
			Socket.last.frame({ type: "activity" });
			expect(activity).toHaveBeenCalledTimes(1);
			Socket.last.frame({ type: "exit" });
			expect(exit).toHaveBeenCalledTimes(1);
		} finally {
			subscription();
		}
	});

	// Catches: a disconnected remote terminal silently falls back to the local daemon.
	it("rejects a disconnected owner without subscribing locally", async () => {
		vi.stubGlobal("__TAURI_INTERNALS__", {});
		setSessionConnectionLookup(() => "mint");
		await expect(subscribePty("remote-1", vi.fn(), vi.fn())).rejects.toThrow("Remote connection mint not connected");
	});
});
