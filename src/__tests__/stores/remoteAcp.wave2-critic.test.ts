import { expect, it, vi } from "vitest";

const { handlers, remoteRpc } = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	remoteRpc: vi.fn(),
}));
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

// Catches: a card notice cancels an in-flight permission refresh without replacing it, hiding Boss's approval.
it("retains a remote permission refresh when a card arrives before the response", async () => {
	const pending = [
		{
			kind: "permission" as const,
			requestId: "permission-1",
			sessionId: "chat-1",
			request: {
				sessionId: "chat-1",
				toolCall: { title: "Run tests" },
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
			},
		},
	];
	let resolve!: (value: typeof pending) => void;
	remoteRpc.mockImplementation(
		() =>
			new Promise<typeof pending>((done) => {
				resolve = done;
			}),
	);
	const { setRemoteBaseUrlLookup } = await import("../../transportRuntime");
	setRemoteBaseUrlLookup(() => "http://daemon");
	const { remoteAcpStore } = await import("../../stores/remoteAcp");
	const base = {
		connectionId: "acp-1",
		generation: 1,
		sessionId: "chat-1",
		__tuic_origin: { connection: "daemon-1", name: "Linux" },
	};
	const onNotice = handlers.get("acp-notice")!;
	onNotice({ payload: { ...base, kind: "interaction_pending", requestId: "permission-1", sequence: 1 } });
	onNotice({ payload: { ...base, kind: "card", requestId: null, sequence: 2 } });
	resolve(pending);
	await Promise.resolve();
	expect(remoteAcpStore.state.entries[JSON.stringify(["daemon-1", "acp-1"])]?.interactions).toEqual(pending);
});
