import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @tauri-apps/api/core — conversationStore dynamic-imports invoke from here.
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
	Channel: class {
		onmessage: ((_msg: unknown) => void) | null = null;
	},
}));

// Force isTauri() = true so persistence paths execute.
vi.mock("../../transport", () => ({
	isTauri: () => true,
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

describe("conversationStore persistence (1385-87c6)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		globalThis.localStorage?.clear();
		store = (await import("../../stores/conversationStore")).conversationStore;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("initFromDisk assigns a new conversation id when no tuicSession", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "new_conversation_id") return Promise.resolve("fresh-id");
			return Promise.resolve();
		});

		await store.initFromDisk();
		expect(store.chatId()).toBe("fresh-id");
	});

	it("addAssistantMessage triggers a debounced save_conversation invoke", async () => {
		mockInvoke.mockResolvedValue(undefined);
		store.addAssistantMessage("hello world");
		// Before debounce window elapses, no save yet.
		expect(mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation").length).toBe(0);
		await vi.advanceTimersByTimeAsync(600);
		const saves = mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation");
		expect(saves.length).toBe(1);
		const conv = saves[0]?.[1]?.conversation;
		expect(conv.messages.length).toBe(1);
		expect(conv.messages[0].role).toBe("assistant");
		expect(conv.schema_version).toBe(1);
	});

	it("clearHistory resets streaming state and deletes from disk", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "new_conversation_id") return Promise.resolve("next-id");
			return Promise.resolve();
		});
		store.addUserMessage("question");
		store.appendStreamChunk("partial");
		store.setStreaming(true);
		expect(store.messages().length).toBe(1);
		expect(store.streamingText()).toBe("partial");

		const prevId = store.chatId();
		store.clearHistory();
		expect(store.messages().length).toBe(0);
		expect(store.streamingText()).toBe("");
		expect(store.isStreaming()).toBe(false);

		await vi.runAllTimersAsync();
		const deletes = mockInvoke.mock.calls.filter((c) => c[0] === "delete_conversation");
		expect(deletes.length).toBe(1);
		expect(deletes[0]?.[1]).toEqual({ id: prevId });
		expect(store.chatId()).toBe("next-id");
	});

	it("initFromDisk loads messages with missing content as empty string (1405-3464)", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_conversations") {
				return Promise.resolve([
					{ id: "corrupt-123", title: "t", session_id: "sess-corrupt", created: 1, updated: 2, message_count: 2 },
				]);
			}
			if (cmd === "load_conversation") {
				return Promise.resolve({
					meta: { id: "corrupt-123", title: "t", session_id: "sess-corrupt", created: 1, updated: 2, message_count: 2 },
					messages: [
						{ role: "user", content: "hello", timestamp: 1 },
						{ role: "assistant", timestamp: 2 }, // missing content
					],
					schema_version: 1,
				});
			}
			return Promise.resolve();
		});

		await store.initFromDisk("sess-corrupt");
		expect(store.messages().length).toBe(2);
		expect(store.messages()[1]?.content).toBe("");
	});

	it("round-trip: message with empty content persists without serde error (1405-3464)", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_conversations") {
				return Promise.resolve([
					{ id: "rt-123", title: "t", session_id: "sess-rt", created: 1, updated: 2, message_count: 1 },
				]);
			}
			if (cmd === "load_conversation") {
				return Promise.resolve({
					meta: { id: "rt-123", title: "t", session_id: "sess-rt", created: 1, updated: 2, message_count: 1 },
					messages: [{ role: "user", timestamp: 1 }], // missing content
					schema_version: 1,
				});
			}
			return Promise.resolve();
		});

		await store.initFromDisk("sess-rt");
		// Trigger persist — should call save_conversation with content: ""
		store.addAssistantMessage("reply");
		await vi.advanceTimersByTimeAsync(600);

		const saves = mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation");
		expect(saves.length).toBe(1);
		const msgs = saves[0]?.[1]?.conversation?.messages as Array<{ role: string; content: string }>;
		const userMsg = msgs.find((m) => m.role === "user");
		expect(userMsg?.content).toBe("");
	});
});

describe("conversationStore terminal lifecycle (1410-1be8)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		globalThis.localStorage?.clear();
		store = (await import("../../stores/conversationStore")).conversationStore;
		mockInvoke.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("onTerminalClose cancels in-flight stream and frees memory", async () => {
		store.setActiveTerminal("T1");
		await store.sendMessage("hello", "sess-T1");

		// T1 is streaming; close it
		await store.onTerminalClose("T1");

		const cancelCalls = mockInvoke.mock.calls.filter((c) => c[0] === "cancel_conversation");
		expect(cancelCalls.length).toBe(1);

		// State should be freed — getOrCreate returns a fresh empty state
		const state = store.getOrCreate("T1");
		expect(state.messages()).toEqual([]);
		expect(state.isStreaming()).toBe(false);
	});

	it("onTerminalClose while idle frees memory without cancel_ai_chat", async () => {
		store.setActiveTerminal("T1");
		store.addUserMessage("hello");

		await store.onTerminalClose("T1");

		const cancelCalls = mockInvoke.mock.calls.filter((c) => c[0] === "cancel_ai_chat");
		expect(cancelCalls.length).toBe(0);

		// Memory freed
		const state = store.getOrCreate("T1");
		expect(state.messages()).toEqual([]);
	});

	it("onTerminalClose persists partial messages before freeing", async () => {
		store.setActiveTerminal("T1");
		store.addUserMessage("partial question");
		store.appendStreamChunk("partial ans");

		await store.onTerminalClose("T1");

		await vi.advanceTimersByTimeAsync(600);
		const saves = mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation");
		expect(saves.length).toBe(1);
	});
});

describe("conversationStore streaming — per-terminal (1408-a8d8)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;
	// Capture Channel instances so we can fire callbacks manually
	const channels: Map<string, { onmessage: ((msg: unknown) => void) | null }> = new Map();

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		channels.clear();
		globalThis.localStorage?.clear();

		mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
			if (cmd === "start_conversation") {
				// Capture the channel by the active terminal key (we don't have chatId here, use a counter)
				const ch = args?.["onEvent"] as { onmessage: ((msg: unknown) => void) | null };
				// Use sessionId as the channel key since that's what start_conversation receives
				if (ch && args?.["sessionId"]) channels.set(args["sessionId"] as string, ch);
				return Promise.resolve();
			}
			if (cmd === "new_conversation_id") return Promise.resolve("new-id");
			return Promise.resolve();
		});

		store = (await import("../../stores/conversationStore")).conversationStore;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("text_chunk from T1 stream updates T1 streamingText, not T2 (1408-a8d8)", async () => {
		store.setActiveTerminal("T1");
		await store.sendMessage("hello from T1", "sess-T1");

		store.setActiveTerminal("T2");
		await store.sendMessage("hello from T2", "sess-T2");

		// Fire text_chunk for T1's channel (keyed by sessionId "sess-T1")
		const ch1 = channels.get("sess-T1");
		expect(ch1).toBeDefined();
		ch1!.onmessage?.({ type: "text_chunk", text: "T1 chunk" });

		// T1 should have streaming text, T2 should not
		store.setActiveTerminal("T1");
		expect(store.streamingText()).toBe("T1 chunk");
		store.setActiveTerminal("T2");
		expect(store.streamingText()).toBe("");
	});

	it("completed event for T1 finalizes T1 messages, T2 unaffected (1408-a8d8)", async () => {
		store.setActiveTerminal("T1");
		await store.sendMessage("q", "sess-T1");

		store.setActiveTerminal("T2");
		await store.sendMessage("q2", "sess-T2");

		// Fire text_chunk then completed for T1 while T2 is active
		const ch1 = channels.get("sess-T1");
		expect(ch1).toBeDefined();
		ch1!.onmessage?.({ type: "text_chunk", text: "T1 response" });
		ch1!.onmessage?.({ type: "completed", reason: "end_turn", usage: null });

		store.setActiveTerminal("T1");
		expect(store.isStreaming()).toBe(false);
		const msgs = store.messages();
		expect(msgs[msgs.length - 1]?.content).toBe("T1 response");

		// T2 should still be streaming
		store.setActiveTerminal("T2");
		expect(store.isStreaming()).toBe(true);
	});
});

describe("conversationStore persistence — per-terminal (1407-56ca)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		globalThis.localStorage?.clear();
		store = (await import("../../stores/conversationStore")).conversationStore;
		mockInvoke.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedulePersist for terminal A fires A's data even after switching to terminal B", async () => {
		store.setActiveTerminal("termA");
		store.addAssistantMessage("hello from A");
		// Timer for A is now scheduled. Switch to B before it fires.
		store.setActiveTerminal("termB");
		store.addAssistantMessage("hello from B");

		await vi.advanceTimersByTimeAsync(600);

		const saves = mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation");
		// Both timers fire — one for A, one for B
		expect(saves.length).toBe(2);
		const contents = saves.map((c) => (c[1]?.conversation?.messages as Array<{ content: string }>)?.[0]?.content);
		expect(contents).toContain("hello from A");
		expect(contents).toContain("hello from B");
	});

	it("two terminals persist with independent session_id in meta", async () => {
		store.setActiveTerminal("termA");
		store.addAssistantMessage("A message");

		store.setActiveTerminal("termB");
		store.addAssistantMessage("B message");

		await vi.advanceTimersByTimeAsync(600);

		const saves = mockInvoke.mock.calls.filter((c) => c[0] === "save_conversation");
		expect(saves.length).toBe(2);
		const sessionIds = saves.map((c) => c[1]?.conversation?.meta?.session_id as string);
		expect(sessionIds).toContain("termA");
		expect(sessionIds).toContain("termB");
	});

	it("initFromDisk(tuicSession) loads conversation filtered by session_id via list_conversations", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_conversations") {
				return Promise.resolve([
					{ id: "conv-old", title: "old", session_id: "sess-X", created: 1, updated: 1, message_count: 1 },
					{ id: "conv-new", title: "new", session_id: "sess-X", created: 2, updated: 5, message_count: 2 },
					{ id: "conv-other", title: "other", session_id: "sess-Y", created: 3, updated: 3, message_count: 1 },
				]);
			}
			if (cmd === "load_conversation") {
				return Promise.resolve({
					meta: { id: "conv-new", title: "new", session_id: "sess-X", created: 2, updated: 5, message_count: 2 },
					messages: [
						{ role: "user", content: "hi", timestamp: 2 },
						{ role: "assistant", content: "hello", timestamp: 3 },
					],
					schema_version: 1,
				});
			}
			return Promise.resolve();
		});

		store.setActiveTerminal("termX");
		await store.initFromDisk("sess-X");

		expect(store.messages().length).toBe(2);
		expect(store.chatId()).toBe("conv-new");
		const loadCalls = mockInvoke.mock.calls.filter((c) => c[0] === "load_conversation");
		expect(loadCalls[0]?.[1]).toEqual({ id: "conv-new" });
	});
});

describe("conversationStore history panel (1412-ae57)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		globalThis.localStorage?.clear();
		store = (await import("../../stores/conversationStore")).conversationStore;
		mockInvoke.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("listAllConversations returns all conversations from backend", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "list_conversations") {
				return Promise.resolve([
					{ id: "c1", title: "First chat", session_id: "s1", created: 1, updated: 1, message_count: 1 },
					{ id: "c2", title: "Second chat", session_id: "s2", created: 2, updated: 2, message_count: 3 },
				]);
			}
			return Promise.resolve();
		});

		const convs = await store.listAllConversations();
		expect(convs).toHaveLength(2);
		expect(convs[0]?.id).toBe("c1");
		expect(convs[1]?.title).toBe("Second chat");
		const listCalls = mockInvoke.mock.calls.filter((c) => c[0] === "list_conversations");
		expect(listCalls.length).toBe(1);
	});

	it("loadConversation replaces active terminal messages with loaded conversation", async () => {
		store.addUserMessage("old message");
		expect(store.messages()).toHaveLength(1);

		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "load_conversation") {
				return Promise.resolve({
					meta: { id: "past-conv", title: "Past", created: 1, updated: 2, message_count: 2 },
					messages: [
						{ role: "user", content: "hello", timestamp: 1 },
						{ role: "assistant", content: "hi", timestamp: 2 },
					],
					schema_version: 1,
				});
			}
			return Promise.resolve();
		});

		await store.loadConversation("past-conv");
		expect(store.messages()).toHaveLength(2);
		expect(store.messages()[0]?.content).toBe("hello");
		expect(store.messages()[1]?.content).toBe("hi");
		expect(store.chatId()).toBe("past-conv");
		expect(store.isStreaming()).toBe(false);
	});

	it("loadConversation does not affect other terminal states", async () => {
		store.setActiveTerminal("T1");
		store.addUserMessage("T1 message");

		store.setActiveTerminal("T2");
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "load_conversation") {
				return Promise.resolve({
					meta: { id: "loaded-conv", title: "Loaded", created: 1, updated: 1, message_count: 1 },
					messages: [{ role: "user", content: "loaded", timestamp: 1 }],
					schema_version: 1,
				});
			}
			return Promise.resolve();
		});
		await store.loadConversation("loaded-conv");

		expect(store.messages()).toHaveLength(1);

		store.setActiveTerminal("T1");
		expect(store.messages()).toHaveLength(1);
		expect(store.messages()[0]?.content).toBe("T1 message");
	});
});
