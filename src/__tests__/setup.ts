// Global test setup: signal to transport.ts/invoke.ts that we're in Tauri mode.
//
// `invoke` is stubbed rather than left absent. `isTauri()` only checks that the
// global exists, so an empty object routes every unmocked `rpc()` into
// @tauri-apps/api, which threw `__TAURI_INTERNALS__.invoke is not a function`
// as an UNHANDLED rejection: a component that fetches on mount (a
// `createResource` in a tab the test happens to open) poisoned the whole run
// with an error Vitest attributes to whichever file was executing, not to the
// component. Rejecting with a named error keeps the failure attached to the
// call that made it, and a resource fetcher stores it instead of escaping.
//
// A test that means to exercise a command mocks it — `src/__tests__/mocks/tauri`
// replaces the module. Reaching this stub means nothing was mocked, so it must
// never look like success: resolving would silently feed `undefined` to code
// expecting data.
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
	invoke: (cmd: string) =>
		Promise.reject(new Error(`unmocked Tauri command "${cmd}" — mock it via src/__tests__/mocks/tauri`)),
};

// happy-dom may ship a Proxy-based localStorage missing .clear(),
// or Node may not provide localStorage at all (no --localstorage-file).
// Replace the entire global with a spec-compliant shim in either case.
if (typeof localStorage === "undefined" || typeof localStorage.clear !== "function") {
	const store = new Map<string, string>();
	const shim: Storage = {
		get length() {
			return store.size;
		},
		clear() {
			store.clear();
		},
		getItem(key: string) {
			return store.get(key) ?? null;
		},
		key(index: number) {
			return [...store.keys()][index] ?? null;
		},
		removeItem(key: string) {
			store.delete(key);
		},
		setItem(key: string, value: string) {
			store.set(key, String(value));
		},
	};
	Object.defineProperty(globalThis, "localStorage", { value: shim, writable: true, configurable: true });
}

// happy-dom's EventSource and WebSocket open REAL TCP connections to the default
// origin (http://localhost:3000). Browser-mode code paths — invoke.ts ensureSse()
// and the transport WebSocket — then leak sockets that fail with ECONNREFUSED.
// With detectAsyncLeaks on, vitest blames a RANDOM later test, so the whole suite
// is flaky (a different victim each run). Replace both globals with inert stubs
// that never touch the network. Tests that exercise socket behaviour install their
// own mock (vi.stubGlobal / direct assignment), which takes precedence and
// restores back to these stubs afterwards.
class InertEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;
	readyState = 1; // OPEN — never connects, but lets ensureSse() cache the instance
	url: string;
	withCredentials = false;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	constructor(url: string | URL) {
		this.url = String(url);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return false;
	}
	close(): void {
		this.readyState = 2;
	}
}
Object.defineProperty(globalThis, "EventSource", {
	value: InertEventSource,
	writable: true,
	configurable: true,
});

class InertWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 0; // CONNECTING — never opens, never leaks a real socket
	url: string;
	binaryType = "blob";
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: unknown) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: unknown) => void) | null = null;
	constructor(url: string | URL) {
		this.url = String(url);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	dispatchEvent(): boolean {
		return false;
	}
	send(): void {}
	close(): void {
		this.readyState = 3;
	}
}
Object.defineProperty(globalThis, "WebSocket", {
	value: InertWebSocket,
	writable: true,
	configurable: true,
});

// Unmocked browser-mode RPCs must fail locally instead of reaching
// happy-dom's default origin (http://localhost:3000). Tests that exercise
// HTTP install a response mock for the request they expect.
Object.defineProperty(globalThis, "fetch", {
	value: (input: RequestInfo | URL) => {
		throw new Error(`unmocked fetch in Vitest: ${String(input)}`);
	},
	writable: true,
	configurable: true,
});

// The DOM environment has no layout engine and ships no ResizeObserver. A no-op
// keeps components that observe their size mountable; a test that needs
// notifications stubs its own with vi.stubGlobal.
if (typeof ResizeObserver === "undefined") {
	(globalThis as Record<string, unknown>).ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
}
