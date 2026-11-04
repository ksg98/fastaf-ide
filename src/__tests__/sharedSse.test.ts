import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Source {
	static readonly CLOSED = 2;
	static instances: Source[] = [];
	readyState = 1;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, EventListener[]>();
	constructor(readonly url: string) {
		Source.instances.push(this);
	}
	addEventListener(type: string, handler: EventListener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
	}
	emit(type: string, payload: unknown) {
		for (const handler of this.listeners.get(type) ?? [])
			handler(new MessageEvent(type, { data: JSON.stringify(payload) }));
	}
	close() {
		this.readyState = 2;
	}
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let subscribe: typeof import("../transport/sse").subscribeSse;
const disposers: Array<() => void> = [];
function watch(...args: Parameters<typeof subscribe>) {
	const dispose = subscribe(...args);
	disposers.push(dispose);
	return dispose;
}
beforeEach(async () => {
	vi.resetModules();
	Source.instances = [];
	vi.stubGlobal("EventSource", Source);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
	({ subscribeSse: subscribe } = await import("../transport/sse"));
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

describe("shared SSE lifetime and isolation", () => {
	it("keeps sibling consumers alive and closes only after the final idempotent unsubscribe", async () => {
		// Catches: closing the markdown menu disconnects session/Chat updates.
		const session = vi.fn();
		const markdown = vi.fn();
		const stopSession = watch({ "chat-view-changed": session });
		const stopMarkdown = watch({ "open-markdown-tabs-changed": markdown });
		await flush();
		const source = Source.instances[0];
		source.emit("chat-view-changed", { session_id: "one" });
		expect(session).toHaveBeenCalledOnce();
		expect(markdown).not.toHaveBeenCalled();
		stopMarkdown();
		stopMarkdown();
		source.emit("open-markdown-tabs-changed", {});
		source.emit("chat-view-changed", { session_id: "two" });
		expect(markdown).not.toHaveBeenCalled();
		expect(session).toHaveBeenCalledTimes(2);
		expect(source.readyState).toBe(1);
		stopSession();
		expect(source.readyState).toBe(2);
	});

	it("does not share streams or local HTTP-response events across backend owners", async () => {
		// Catches: an explicit remote backend reuses the local stream or receives its synthetic events.
		const local = vi.fn();
		const remote = vi.fn();
		watch({ changed: local });
		watch({ changed: remote }, { baseUrl: "http://remote.invalid" });
		watch({ other: vi.fn() }, { baseUrl: `${window.location.origin}/` });
		await flush();
		expect(Source.instances).toHaveLength(2);
		const { emitSseLocalEvent } = await import("../transport/sse");
		emitSseLocalEvent("changed", { local: true });
		expect(local).toHaveBeenCalledExactlyOnceWith({ local: true });
		expect(remote).not.toHaveBeenCalled();
	});

	it("cancels a queued open after the last consumer leaves", async () => {
		// Catches: mount/dispose in the same tick leaks an unowned long-lived stream.
		watch({ changed: vi.fn() })();
		await flush();
		expect(Source.instances).toHaveLength(0);
	});

	it("resyncs late consumers only after their filter is live and restores it before reconnect resync", async () => {
		// Catches: a successful snapshot before widening/reconnect leaves a stale consumer forever.
		const initial = vi.fn();
		const late = vi.fn();
		watch({ session: vi.fn() }, { onResync: initial });
		await flush();
		const source = Source.instances[0];
		source.onopen?.();
		let accept!: (response: { ok: boolean }) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise((resolve) => {
						accept = resolve;
					}),
			),
		);
		watch({ dictation: vi.fn() }, { onResync: late });
		await flush();
		expect(late).not.toHaveBeenCalled();
		accept({ ok: true });
		await flush();
		expect(late).toHaveBeenCalledExactlyOnceWith("connect");
		source.onerror?.();
		source.onopen?.();
		expect(late).toHaveBeenCalledTimes(1);
		accept({ ok: true });
		await flush();
		expect(late).toHaveBeenLastCalledWith("reconnect");
		expect(Source.instances).toHaveLength(1);
		source.emit("lagged", { skipped: 3 });
		expect(initial).toHaveBeenLastCalledWith("lagged");
		expect(late).toHaveBeenLastCalledWith("lagged");
	});

	it("serializes late filter updates and ignores replies after final cleanup", async () => {
		// Catches: out-of-order POSTs narrow the stream; a stale failure resurrects a disposed stream.
		watch({ first: vi.fn() });
		await flush();
		const replies: Array<(response: { ok: boolean }) => void> = [];
		const fetch = vi.fn(() => new Promise((resolve) => replies.push(resolve)));
		vi.stubGlobal("fetch", fetch);
		watch({ second: vi.fn() });
		await flush();
		watch({ third: vi.fn() });
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);
		replies[0]({ ok: true });
		await flush();
		expect(fetch).toHaveBeenCalledTimes(2);
		const body = JSON.parse((fetch.mock.calls[1] as unknown as [string, { body: string }])[1].body);
		expect(body.types).toEqual(["first", "second", "third"]);
		for (const dispose of disposers) dispose();
		replies[1]({ ok: false });
		await flush();
		expect(Source.instances).toHaveLength(1);
		expect(Source.instances[0].readyState).toBe(2);
	});
});
