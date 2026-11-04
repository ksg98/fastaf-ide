import { beforeEach, expect, it, vi } from "vitest";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const remoteRpc = vi.fn();
vi.mock("../../invoke", () => ({
	listen: vi.fn((name, callback) => {
		handlers.set(name, callback);
		return Promise.resolve(() => {});
	}),
}));
vi.mock("../../transport", () => ({ rpc: remoteRpc }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { debug: vi.fn() } }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));
vi.mock("../../stores/ui", () => ({ uiStore: { setAiChatPanelVisible: vi.fn() } }));
let store: typeof import("../../stores/remoteAcp").remoteAcpStore;
const pending = [
	{
		kind: "permission",
		requestId: "request",
		sessionId: "session",
		request: {
			sessionId: "session",
			toolCall: { title: "Run command" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		},
	},
];
function notice(host: string, kind = "interaction_pending") {
	handlers.get("acp-notice")?.({
		payload: { connectionId: "acp", requestId: "request", kind, __tuic_origin: { connection: host, name: host } },
	});
}
beforeEach(async () => {
	vi.resetModules();
	handlers.clear();
	remoteRpc.mockReset().mockResolvedValue(pending);
	const { setRemoteBaseUrlLookup } = await import("../../transportRuntime");
	setRemoteBaseUrlLookup(() => "http://daemon");
	store = (await import("../../stores/remoteAcp")).remoteAcpStore;
});
it("keeps colliding ACP requests on their owning daemon when answering and settling", async () => {
	notice("one");
	notice("two");
	await Promise.resolve();
	const one = JSON.stringify(["one", "acp"]);
	const two = JSON.stringify(["two", "acp"]);
	expect(Object.keys(store.state.entries)).toHaveLength(2);
	remoteRpc.mockResolvedValue(undefined);
	await store.answerPermission(one, "request", { outcome: "selected", optionId: "allow" });
	expect(remoteRpc).toHaveBeenLastCalledWith(
		"acp_respond_permission",
		{ connectionId: "acp", requestId: "request", outcome: { outcome: "selected", optionId: "allow" } },
		"one",
	);
	expect(store.state.entries[one]).toBeUndefined();
	expect(store.state.entries[two]).toBeDefined();
	notice("two", "settled");
	expect(Object.keys(store.state.entries)).toHaveLength(0);
});
it("does not resurrect remote questions from a refresh completed after disconnect", async () => {
	let resolve!: (value: typeof pending) => void;
	remoteRpc.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	notice("one");
	handlers.get("remote-connection-status")?.({ payload: { id: "one", status: "disconnected" } });
	resolve(pending);
	await Promise.resolve();
	expect(Object.keys(store.state.entries)).toHaveLength(0);
	handlers.get("acp-notice")?.({ payload: { connectionId: "local", kind: "interaction_pending" } });
	expect(remoteRpc).toHaveBeenCalledTimes(1);
});

// Catches: an in-flight permission snapshot resurrects a settled ACP connection.
it("does not resurrect remote questions from a refresh completed after settlement", async () => {
	let resolve!: (value: typeof pending) => void;
	remoteRpc.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	notice("one");
	notice("one", "settled");
	resolve(pending);
	await Promise.resolve();
	expect(Object.keys(store.state.entries)).toHaveLength(0);
});
