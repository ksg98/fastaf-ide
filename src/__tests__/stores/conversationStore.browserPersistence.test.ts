import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { directTauriInvoke, mockInvoke, mockLogger } = vi.hoisted(() => ({
	directTauriInvoke: vi.fn(),
	mockInvoke: vi.fn(),
	mockLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
}));

vi.mock("../../transport", () => ({
	isTauri: () => false,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: directTauriInvoke,
	Channel: class {
		onmessage: ((message: unknown) => void) | null = null;
	},
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: mockLogger,
}));

interface SavedConversation {
	meta: {
		id: string;
		title: string;
		session_id?: string | null;
		created: number;
		updated: number;
		message_count: number;
	};
	messages: Array<{ role: string; content: string; timestamp: number }>;
	schema_version: number;
}

describe("conversationStore browser persistence (641-b890)", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		directTauriInvoke.mockReset();
		for (const logger of Object.values(mockLogger)) logger.mockReset();
		store = (await import("../../stores/conversationStore")).conversationStore;
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("autosaves through shared invoke and restores the conversation after a page reload", async () => {
		let saved: SavedConversation | undefined;
		mockInvoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
			switch (command) {
				case "load_ai_chat_config":
					return Promise.resolve({ provider: "ollama", model: "qwen" });
				case "save_conversation":
					saved = args?.conversation as SavedConversation;
					return Promise.resolve();
				case "list_conversations":
					return Promise.resolve(saved ? [saved.meta] : []);
				case "load_conversation":
					return Promise.resolve(saved);
				default:
					return Promise.resolve();
			}
		});

		store.setActiveTerminal("browser-terminal");
		store.addUserMessage("Persist this browser conversation");
		store.addAssistantMessage("Saved through HTTP");

		await vi.advanceTimersByTimeAsync(499);
		expect(saved).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);

		expect(saved?.meta.session_id).toBe("browser-terminal");
		expect(saved?.messages.map((message) => message.content)).toEqual([
			"Persist this browser conversation",
			"Saved through HTTP",
		]);

		vi.resetModules();
		const reloadedStore = (await import("../../stores/conversationStore")).conversationStore;
		reloadedStore.setActiveTerminal("browser-terminal");
		await reloadedStore.initFromDisk("browser-terminal");

		expect(reloadedStore.chatId()).toBe(saved?.meta.id);
		expect(reloadedStore.messages().map((message) => message.content)).toEqual([
			"Persist this browser conversation",
			"Saved through HTTP",
		]);
		expect(mockInvoke).toHaveBeenCalledWith("list_conversations");
		expect(mockInvoke).toHaveBeenCalledWith("load_conversation", { id: saved?.meta.id });
		expect(directTauriInvoke).not.toHaveBeenCalled();
	});

	it("persists immediately when a browser terminal closes", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "load_ai_chat_config") return Promise.resolve({ provider: "ollama", model: "qwen" });
			return Promise.resolve();
		});
		store.setActiveTerminal("closing-terminal");
		store.addUserMessage("Save before closing");

		await store.onTerminalClose("closing-terminal");

		const saves = mockInvoke.mock.calls.filter(([command]) => command === "save_conversation");
		expect(saves).toHaveLength(1);
		expect(saves[0]?.[1]?.conversation.meta.session_id).toBe("closing-terminal");
		expect(directTauriInvoke).not.toHaveBeenCalled();
	});

	it("lists, opens, and deletes browser history through shared invoke", async () => {
		const conversation: SavedConversation = {
			meta: {
				id: "history-id",
				title: "Browser history",
				session_id: "browser-terminal",
				created: 1,
				updated: 2,
				message_count: 2,
			},
			messages: [
				{ role: "user", content: "Earlier question", timestamp: 1 },
				{ role: "assistant", content: "Earlier answer", timestamp: 2 },
			],
			schema_version: 1,
		};
		mockInvoke.mockImplementation((command: string) => {
			switch (command) {
				case "list_conversations":
					return Promise.resolve([conversation.meta]);
				case "load_conversation":
					return Promise.resolve(conversation);
				case "new_conversation_id":
					return Promise.resolve("replacement-id");
				default:
					return Promise.resolve();
			}
		});

		await expect(store.listAllConversations()).resolves.toEqual([conversation.meta]);
		await store.loadConversation(conversation.meta.id);
		expect(store.messages().map((message) => message.content)).toEqual(["Earlier question", "Earlier answer"]);

		store.clearHistory();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockInvoke).toHaveBeenCalledWith("delete_conversation", { id: conversation.meta.id });
		expect(mockInvoke).toHaveBeenCalledWith("new_conversation_id");
		expect(store.chatId()).toBe("replacement-id");
		expect(store.messages()).toEqual([]);
		expect(directTauriInvoke).not.toHaveBeenCalled();
	});

	it("reports browser persistence failures without rejecting store actions", async () => {
		mockInvoke.mockImplementation((command: string) => {
			if (command === "load_ai_chat_config") return Promise.resolve({ provider: "ollama", model: "qwen" });
			return Promise.reject(new Error(`${command} failed`));
		});

		await expect(store.listAllConversations()).resolves.toEqual([]);
		await expect(store.loadConversation("missing-id")).resolves.toBeUndefined();
		store.setActiveTerminal("failing-terminal");
		store.addUserMessage("Cannot save this");
		await expect(store.onTerminalClose("failing-terminal")).resolves.toBeUndefined();

		expect(mockLogger.warn).toHaveBeenCalledWith("conversation", "listAllConversations failed", expect.any(Object));
		expect(mockLogger.warn).toHaveBeenCalledWith(
			"conversation",
			"loadConversation failed",
			expect.objectContaining({ id: "missing-id" }),
		);
		expect(mockLogger.warn).toHaveBeenCalledWith("conversation", "persistNow failed", expect.any(Object));
	});

	it("drops a stale browser history read when a newer local turn overtakes it", async () => {
		let resolveLoad: (conversation: SavedConversation) => void = () => {};
		mockInvoke.mockImplementation((command: string) => {
			if (command === "load_conversation") {
				return new Promise<SavedConversation>((resolve) => {
					resolveLoad = resolve;
				});
			}
			if (command === "load_ai_chat_config") return Promise.resolve({ provider: "ollama", model: "qwen" });
			return Promise.resolve();
		});

		const loading = store.loadConversation("older-history");
		store.addUserMessage("Newer browser turn");
		resolveLoad({
			meta: {
				id: "older-history",
				title: "Older",
				created: 1,
				updated: 1,
				message_count: 1,
			},
			messages: [{ role: "user", content: "Older turn", timestamp: 1 }],
			schema_version: 1,
		});

		await loading;

		expect(store.messages().map((message) => message.content)).toEqual(["Newer browser turn"]);
		expect(store.chatId()).not.toBe("older-history");
		expect(mockLogger.info).toHaveBeenCalledWith(
			"conversation",
			"loadConversation: dropped a read the conversation outran",
			{ id: "older-history" },
		);
		expect(directTauriInvoke).not.toHaveBeenCalled();
	});
});
