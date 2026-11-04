import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(__dirname, "../../../public/sw.js"), "utf-8");

type Listener = (event: unknown) => void;

/** Run public/sw.js against stubs and return its `fetch` listener plus the cache spy. */
function loadWorker(response: { ok: boolean; status?: number; type?: string }) {
	const listeners: Record<string, Listener> = {};
	const put = vi.fn();
	const caches = {
		open: async () => ({ put }),
		match: async () => undefined,
		keys: async () => [],
	};
	const self = {
		addEventListener: (name: string, fn: Listener) => {
			listeners[name] = fn;
		},
	};
	const fetchStub = vi.fn(async () => ({ ...response, clone: () => ({ cloned: true }) }));
	new Function("self", "caches", "fetch", "clients", "crypto", source)(
		self,
		caches,
		fetchStub,
		{},
		{ randomUUID: () => "k" },
	);
	return { listeners, put, fetchStub };
}

async function navigate(path: string, response: { ok: boolean; status?: number; type?: string }) {
	const worker = loadWorker(response);
	let pending: Promise<unknown> | undefined;
	worker.listeners.fetch({
		request: { method: "GET", url: `http://tuic.test:9876${path}`, mode: "navigate" },
		respondWith: (p: Promise<unknown>) => {
			pending = p;
		},
	});
	await pending;
	await new Promise((r) => setTimeout(r, 0));
	return worker;
}

describe("service worker and the login flow", () => {
	// Plausible bug: the worker stores the opaque redirect that the server answers an expired session with.
	it("does not cache the opaque redirect to the login page", async () => {
		const { put } = await navigate("/mobile", { ok: false, status: 0, type: "opaqueredirect" });
		expect(put).not.toHaveBeenCalled();
	});

	// Plausible bug: the worker intercepts POST /auth/login and swallows the cookie.
	it("does not intercept the login POST", () => {
		const { listeners } = loadWorker({ ok: true });
		const respondWith = vi.fn();
		listeners.fetch({
			request: { method: "POST", url: "http://tuic.test:9876/auth/login", mode: "cors" },
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
	});
});

describe("service worker asset cache", () => {
	/** Plausible bug: hashed /assets files are never cached, so an offline cold start has a shell with no JS. */
	it("serves a cached asset when the network is down", async () => {
		const listeners: Record<string, Listener> = {};
		const stored = new Map<string, unknown>();
		const cache = {
			put: async (req: { url: string }, res: unknown) => void stored.set(req.url, res),
			match: async (req: { url: string }) => stored.get(req.url),
			keys: async () => [...stored.keys()].map((url) => ({ url })),
			delete: async () => true,
		};
		const caches = { open: async () => cache, match: async () => undefined, keys: async () => [] };
		const self = {
			location: { origin: "http://tuic.test:9876" },
			addEventListener: (n: string, f: Listener) => void (listeners[n] = f),
		};
		let online = true;
		const fetchStub = vi.fn(async () => {
			if (!online) throw new TypeError("offline");
			return { ok: true, clone: () => ({ cloned: true }), body: "js" };
		});
		new Function("self", "caches", "fetch", "clients", "crypto", source)(self, caches, fetchStub, {}, {});
		const request = { method: "GET", url: "http://tuic.test:9876/assets/mobile-abc.js", mode: "cors" };
		const run = async () => {
			let pending: Promise<unknown> | undefined;
			listeners.fetch({ request, respondWith: (p: Promise<unknown>) => void (pending = p) });
			return pending;
		};
		await run();
		online = false;
		await expect(run()).resolves.toMatchObject({ cloned: true });
	});

	// Plausible bug: a pruned chunk gets the SPA fallback (HTML, 200); caching it serves HTML as JS for that URL forever.
	it("does not cache an HTML response for an asset URL", async () => {
		const listeners: Record<string, Listener> = {};
		const put = vi.fn();
		const cache = { put, match: async () => undefined, keys: async () => [], delete: async () => true };
		const caches = { open: async () => cache, match: async () => undefined, keys: async () => [] };
		const self = {
			location: { origin: "http://tuic.test:9876" },
			addEventListener: (n: string, f: Listener) => void (listeners[n] = f),
		};
		const fetchStub = vi.fn(async () => ({
			ok: true,
			headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
			clone: () => ({}),
		}));
		new Function("self", "caches", "fetch", "clients", "crypto", source)(self, caches, fetchStub, {}, {});
		let pending: Promise<unknown> | undefined;
		listeners.fetch({
			request: { method: "GET", url: "http://tuic.test:9876/assets/pruned-abc.js", mode: "cors" },
			respondWith: (p: Promise<unknown>) => void (pending = p),
		});
		await pending;
		expect(put).not.toHaveBeenCalled();
	});

	// Plausible bug: unbounded growth, every rebuild leaves its old hashed files behind.
	it("keeps at most 200 assets", async () => {
		const listeners: Record<string, Listener> = {};
		const stored = new Map<string, unknown>();
		for (let i = 0; i < 205; i++) stored.set(`http://tuic.test:9876/assets/old-${i}.js`, {});
		const cache = {
			put: async (req: { url: string }, res: unknown) => void stored.set(req.url, res),
			match: async () => undefined,
			keys: async () => [...stored.keys()].map((url) => ({ url })),
			delete: async (req: { url: string }) => stored.delete(req.url),
		};
		const caches = { open: async () => cache, match: async () => undefined, keys: async () => [] };
		const self = {
			location: { origin: "http://tuic.test:9876" },
			addEventListener: (n: string, f: Listener) => void (listeners[n] = f),
		};
		const fetchStub = vi.fn(async () => ({ ok: true, clone: () => ({}) }));
		new Function("self", "caches", "fetch", "clients", "crypto", source)(self, caches, fetchStub, {}, {});
		let pending: Promise<unknown> | undefined;
		listeners.fetch({
			request: { method: "GET", url: "http://tuic.test:9876/assets/new.js", mode: "cors" },
			respondWith: (p: Promise<unknown>) => void (pending = p),
		});
		await pending;
		expect(stored.size).toBe(200);
		expect(stored.has("http://tuic.test:9876/assets/new.js")).toBe(true);
	});
});
