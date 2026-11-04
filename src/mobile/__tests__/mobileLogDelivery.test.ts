import { afterEach, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { rpc } from "../../transport";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// Catches: the HTTP route writes the first log and returns 204, but RPC rejects
// its empty body, so the logger replays that entry instead of sending later ones.
it("acknowledges mobile log writes so a second warning reaches the server", async () => {
	vi.stubGlobal("__TAURI_SHIM__", true);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const received: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe(`${location.origin}/logs`);
			expect(init.method).toBe("POST");
			received.push(JSON.parse(String(init.body)));
			// log_routes::push_log returns StatusCode::NO_CONTENT after buffer.push.
			return new Response(null, { status: 204 });
		}),
	);
	appLogger.warn("app", "Mobile diagnostic first", { sequence: 1 });
	await flush();
	appLogger.warn("app", "Mobile diagnostic second", { sequence: 2 });
	await flush();
	expect(received).toEqual([
		expect.objectContaining({
			level: "warn",
			source: "app",
			message: "Mobile diagnostic first",
			data_json: '{"sequence":1}',
		}),
		expect.objectContaining({
			level: "warn",
			source: "app",
			message: "Mobile diagnostic second",
			data_json: '{"sequence":2}',
		}),
	]);
	expect(warn.mock.calls).toEqual([
		["[app]", "Mobile diagnostic first"],
		["[app]", "Mobile diagnostic second"],
	]);
});

// Catches: accepting a missing response for a data RPC hides a broken route.
it("still rejects HTTP 204 for commands that must return JSON", async () => {
	vi.stubGlobal("__TAURI_SHIM__", true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	await expect(rpc("list_active_sessions")).rejects.toThrow("empty response body");
});

// Catches: clearing the shared log ring succeeds on the backend but reports an
// empty-body failure on browser/PWA clients of the same void log API.
it("acknowledges the void clear_logs response without relaxing other empty bodies", async () => {
	vi.stubGlobal("__TAURI_SHIM__", true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	await expect(rpc("clear_logs")).resolves.toBeUndefined();
	vi.mocked(fetch).mockResolvedValue(new Response("", { status: 200 }));
	await expect(rpc("push_log", { level: "warn", source: "app", message: "empty" })).rejects.toThrow(
		"empty response body",
	);
});
