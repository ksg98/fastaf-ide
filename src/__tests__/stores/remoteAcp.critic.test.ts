import { beforeEach, expect, it, vi } from "vitest";
import type { AcpPendingInteraction } from "../../types/acp";

const io = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload: unknown }) => void>(),
	rpc: vi.fn(),
}));
vi.mock("../../invoke", () => ({
	listen: vi.fn((event, handler) => {
		io.handlers.set(event, handler);
		return Promise.resolve(() => {});
	}),
}));
vi.mock("../../transport", () => ({ rpc: io.rpc }));
vi.mock("../../transportRuntime", () => ({ getRemoteBaseUrl: () => "http://daemon:9876" }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { debug: vi.fn() } }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));
vi.mock("../../stores/ui", () => ({ uiStore: { setAiChatPanelVisible: vi.fn() } }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const permission = (requestId: string): AcpPendingInteraction => ({
	kind: "permission",
	requestId,
	sessionId: "chat",
	request: { sessionId: "chat", toolCall: {}, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
});
function notice(kind: string, requestId: string) {
	io.handlers.get("acp-notice")?.({
		payload: {
			connectionId: "ego",
			generation: 1,
			sequence: 1,
			sessionId: "chat",
			requestId,
			kind,
			__tuic_origin: { connection: "mint", name: "Mint" },
		},
	});
}
beforeEach(() => {
	vi.resetModules();
	io.handlers.clear();
	io.rpc.mockReset();
});

// Catches: completing one answer invalidates a newer pending snapshot and hides
// another request indefinitely, leaving the remote agent waiting on Boss.
it("keeps a newer pending request when the previous answer completes before its snapshot", async () => {
	const { remoteAcpStore } = await import("../../stores/remoteAcp");
	io.rpc.mockResolvedValueOnce([permission("first")]);
	notice("interaction_pending", "first");
	await Promise.resolve();
	const key = '["mint","ego"]';
	expect(remoteAcpStore.state.entries[key].interactions[0].requestId).toBe("first");
	const answer = deferred<unknown>();
	const newer = deferred<AcpPendingInteraction[]>();
	io.rpc.mockReturnValueOnce(answer.promise).mockResolvedValueOnce([]).mockReturnValueOnce(newer.promise);
	const answering = remoteAcpStore.answerPermission(key, "first", { outcome: "selected", optionId: "allow" });
	notice("interaction_settled", "first");
	notice("interaction_pending", "second");
	answer.resolve({ requestId: "first" });
	await answering;
	newer.resolve([permission("second")]);
	await Promise.resolve();
	expect(remoteAcpStore.state.entries[key]?.interactions.map((item) => item.requestId)).toEqual(["second"]);
});
