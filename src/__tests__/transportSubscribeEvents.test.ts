import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let subscribeEvents: typeof import("../transport").subscribeEvents;

/**
 * `onResync` is the only signal a consumer gets that events were MISSED — the
 * gap left when the 1 Hz `list_active_sessions` poll was replaced by a push
 * (#687-be9d, #721-7dd5). Both causes are silent by nature: EventSource
 * reconnects without telling anyone, and the backend's bounded broadcast drops
 * frames without resending them. So the tests below are the only place the two
 * are distinguishable at all.
 */
class MockEventSource {
	static readonly instances: MockEventSource[] = [];
	readonly listeners = new Map<string, EventListener[]>();
	readonly close = vi.fn();
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	emit(type: string, data = ""): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }));
		}
	}
}

describe("subscribeEvents onResync", () => {
	beforeEach(async () => {
		vi.resetModules();
		({ subscribeEvents } = await import("../transport"));
		MockEventSource.instances.length = 0;
		vi.stubGlobal("EventSource", MockEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/**
	 * `setup.ts` installs `__TAURI_INTERNALS__` for every test, so the default is
	 * desktop. `__TAURI_SHIM__` is the escape hatch `isTauri()` already honours.
	 */
	function browserMode() {
		vi.stubGlobal("__TAURI_SHIM__", true);
	}

	it("resyncs on initial connection and reconnect to close snapshot gaps", async () => {
		browserMode();
		const onResync = vi.fn();
		await subscribeEvents({ "session-state-changed": vi.fn() }, { onResync });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const es = MockEventSource.instances[0];

		// An initial snapshot can predate the server subscription.
		es.onopen?.();
		expect(onResync).toHaveBeenCalledExactlyOnceWith("connect");

		es.onerror?.();
		es.onopen?.();
		expect(onResync).toHaveBeenLastCalledWith("reconnect");

		es.onerror?.();
		es.onopen?.();
		expect(onResync).toHaveBeenCalledTimes(3);
	});

	// Distinct reasons, not one "something happened" flag: a lagged frame means
	// the connection held and the backend dropped events, which is a capacity
	// problem, while a reconnect means the stream was down. A consumer resyncs
	// identically for both, but whoever reads the log needs to tell them apart.
	it("fires with its own reason on a lagged frame, with no reconnect involved", async () => {
		browserMode();
		const onResync = vi.fn();
		await subscribeEvents({ "session-state-changed": vi.fn() }, { onResync });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const es = MockEventSource.instances[0];

		es.onopen?.();
		onResync.mockClear();
		es.emit("lagged", JSON.stringify({ skipped: 12 }));

		expect(onResync).toHaveBeenCalledExactlyOnceWith("lagged");
	});

	it("reports both causes separately when they happen in one session", async () => {
		browserMode();
		const onResync = vi.fn();
		await subscribeEvents({ "session-state-changed": vi.fn() }, { onResync });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const es = MockEventSource.instances[0];

		es.onopen?.();
		es.emit("lagged", "{}");
		es.onerror?.();
		es.onopen?.();

		expect(onResync.mock.calls.map(([reason]) => reason)).toEqual(["connect", "lagged", "reconnect"]);
	});

	it("delivers normal events without ever calling onResync", async () => {
		browserMode();
		const onResync = vi.fn();
		const handler = vi.fn();
		await subscribeEvents({ "session-state-changed": handler }, { onResync });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const es = MockEventSource.instances[0];

		es.onopen?.();
		onResync.mockClear();
		es.emit("session-state-changed", JSON.stringify({ session_id: "s1" }));

		expect(handler).toHaveBeenCalledExactlyOnceWith({ session_id: "s1" });
		expect(onResync).not.toHaveBeenCalled();
	});

	// Criterion 4 of #721-7dd5. Tauri `listen()` is in-process: nothing can drop,
	// so a desktop resync path would be a SECOND path for a transition that
	// already has one — the exact shape the fix-quality rule calls a race, not a
	// safety net. Proven by the absence of an EventSource, not just by a silent
	// callback: even constructing one on desktop would be the wrong transport.
	it("wires no resync path at all on desktop", async () => {
		const onResync = vi.fn();
		const unsubscribe = await subscribeEvents({ "session-state-changed": vi.fn() }, { onResync });

		expect(MockEventSource.instances).toHaveLength(0);
		expect(onResync).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("still works for a caller that passes no options", async () => {
		browserMode();
		const handler = vi.fn();
		const unsubscribe = await subscribeEvents({ "repo-changed": handler });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const es = MockEventSource.instances[0];

		es.onopen?.();
		es.onerror?.();
		es.onopen?.();
		es.emit("lagged", "{}");
		es.emit("repo-changed", JSON.stringify({ repo_path: "/r" }));

		expect(handler).toHaveBeenCalledExactlyOnceWith({ repo_path: "/r" });
		unsubscribe();
		expect(es.close).toHaveBeenCalledOnce();
	});
});
