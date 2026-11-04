import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "../invoke";
import { subscribeEvents } from "../transport";
import { createAiChatSelectionSync } from "./aiChatSelection";

vi.mock("../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../transport", () => ({ subscribeEvents: vi.fn(async () => () => {}) }));
vi.mock("../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));
const settle = async () => {
	for (let n = 0; n < 12; n++) await Promise.resolve();
};
beforeEach(() => vi.clearAllMocks());

// Catches: phone misses a desktop switch or stays stale after offline reconnect; adoption echoes focus back.
it("adopts owner snapshots on events and reconnect without writing them back", async () => {
	vi.mocked(invoke).mockResolvedValueOnce({ workspace: "/work", sessionId: "desktop" });
	const adopt = vi.fn();
	const sync = createAiChatSelectionSync(adopt);
	await sync.ready;
	expect(adopt).toHaveBeenLastCalledWith({ workspace: "/work", sessionId: "desktop" });
	vi.mocked(invoke).mockResolvedValueOnce({ workspace: "/work", sessionId: "phone" });
	vi.mocked(subscribeEvents).mock.calls[0][0]["ai-chat-selection-changed"]({});
	await settle();
	expect(adopt).toHaveBeenLastCalledWith({ workspace: "/work", sessionId: "phone" });
	vi.mocked(invoke).mockResolvedValueOnce({ workspace: "/work", sessionId: "offline-change" });
	vi.mocked(subscribeEvents).mock.calls[0][1]?.onResync?.("reconnect");
	await settle();
	expect(adopt).toHaveBeenLastCalledWith({ workspace: "/work", sessionId: "offline-change" });
	expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "ai_chat_selection")).toBe(true);
	sync.dispose();
});

// Catches: an older GET or a slow first write rolls back the latest local selection.
it("invalidates stale reads and preserves local write order", async () => {
	let release!: (value: unknown) => void;
	vi.mocked(invoke).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const adopt = vi.fn();
	const sync = createAiChatSelectionSync(adopt);
	await settle();
	sync.invalidate();
	release({ workspace: "/work", sessionId: "stale" });
	await sync.ready;
	expect(adopt).not.toHaveBeenCalled();
	vi.mocked(invoke).mockResolvedValue(undefined);
	await Promise.all([sync.select("first"), sync.select("second")]);
	expect(vi.mocked(invoke).mock.calls.slice(1)).toEqual([
		["select_ai_chat_conversation", { sessionId: "first" }],
		["select_ai_chat_conversation", { sessionId: "second" }],
	]);
	sync.dispose();
});

// Catches: a disconnected/unmounted client applying a late owner snapshot.
it("does not adopt an in-flight read after disposal", async () => {
	let release!: (value: unknown) => void;
	vi.mocked(invoke).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const adopt = vi.fn();
	const sync = createAiChatSelectionSync(adopt);
	await settle();
	sync.dispose();
	release({ workspace: "/work", sessionId: "late" });
	await sync.ready;
	expect(adopt).not.toHaveBeenCalled();
});
