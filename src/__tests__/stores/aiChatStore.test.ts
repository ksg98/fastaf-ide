import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock invoke before importing the store
vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../transport", () => ({
	isTauri: () => false,
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: {
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

import { conversationStore } from "../../stores/conversationStore";

describe("conversationStore (chat)", () => {
	beforeEach(() => {
		conversationStore.clearHistory();
		vi.clearAllMocks();
	});

	// -- Messages --

	it("starts with empty messages", () => {
		expect(conversationStore.messages()).toEqual([]);
	});

	it("addUserMessage appends a user message", () => {
		conversationStore.addUserMessage("hello");
		const msgs = conversationStore.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].content).toBe("hello");
		expect(msgs[0].timestamp).toBeGreaterThan(0);
	});

	it("addAssistantMessage appends an assistant message", () => {
		conversationStore.addAssistantMessage("hi there");
		const msgs = conversationStore.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("assistant");
		expect(msgs[0].content).toBe("hi there");
	});

	it("clearHistory removes all messages", () => {
		conversationStore.addUserMessage("msg1");
		conversationStore.addUserMessage("msg2");
		expect(conversationStore.messages()).toHaveLength(2);
		conversationStore.clearHistory();
		expect(conversationStore.messages()).toEqual([]);
	});

	it("caps messages at 100, dropping oldest", () => {
		for (let i = 0; i < 110; i++) {
			conversationStore.addUserMessage(`msg-${i}`);
		}
		const msgs = conversationStore.messages();
		expect(msgs).toHaveLength(100);
		// First message should be msg-10 (oldest 10 dropped)
		expect(msgs[0].content).toBe("msg-10");
		expect(msgs[99].content).toBe("msg-109");
	});

	// -- Streaming state --

	it("isStreaming starts as false", () => {
		expect(conversationStore.isStreaming()).toBe(false);
	});

	it("streamingText starts empty", () => {
		expect(conversationStore.streamingText()).toBe("");
	});

	it("appendStreamChunk accumulates streaming text", () => {
		conversationStore.setStreaming(true);
		conversationStore.appendStreamChunk("hello ");
		conversationStore.appendStreamChunk("world");
		expect(conversationStore.streamingText()).toBe("hello world");
	});

	it("finalizeStream moves streamingText to assistant message", () => {
		conversationStore.setStreaming(true);
		conversationStore.appendStreamChunk("full response");
		conversationStore.finalizeStream("full response");
		expect(conversationStore.isStreaming()).toBe(false);
		expect(conversationStore.streamingText()).toBe("");
		const msgs = conversationStore.messages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("assistant");
		expect(msgs[0].content).toBe("full response");
	});

	// -- Error state --

	it("error starts as null", () => {
		expect(conversationStore.error()).toBeNull();
	});

	it("setError sets and clears error", () => {
		conversationStore.setError("something failed");
		expect(conversationStore.error()).toBe("something failed");
		conversationStore.setError(null);
		expect(conversationStore.error()).toBeNull();
	});

	// -- Chat ID --

	it("chatId starts as non-empty string", () => {
		expect(conversationStore.chatId()).toBeTruthy();
	});

	it("resetChatId generates a new id", () => {
		const first = conversationStore.chatId();
		conversationStore.resetChatId();
		const second = conversationStore.chatId();
		expect(second).not.toBe(first);
	});
});

describe("conversationStore — session usage accumulator (1415-239d)", () => {
	beforeEach(() => {
		conversationStore.setActiveTerminal("__default__");
		conversationStore.clearHistory();
		vi.clearAllMocks();
	});

	it("sessionUsage starts as null", () => {
		expect(conversationStore.sessionUsage()).toBeNull();
	});

	it("accumulateUsage sums tokens across calls", () => {
		conversationStore.accumulateUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
		conversationStore.accumulateUsage({ promptTokens: 200, completionTokens: 80, totalTokens: 280 });
		const u = conversationStore.sessionUsage();
		expect(u?.promptTokens).toBe(300);
		expect(u?.completionTokens).toBe(130);
	});

	it("accumulateUsage sums cost_usd", () => {
		conversationStore.accumulateUsage({ promptTokens: 100, completionTokens: 50, costUsd: 0.001 });
		conversationStore.accumulateUsage({ promptTokens: 100, completionTokens: 50, costUsd: 0.002 });
		const u = conversationStore.sessionUsage();
		expect(u?.costUsd).toBeCloseTo(0.003);
	});

	it("accumulateUsage accumulates cachedTokens", () => {
		conversationStore.accumulateUsage({ promptTokens: 500, completionTokens: 100, cachedTokens: 300 });
		conversationStore.accumulateUsage({ promptTokens: 200, completionTokens: 50, cachedTokens: 100 });
		const u = conversationStore.sessionUsage();
		expect(u?.cachedTokens).toBe(400);
	});

	it("clearHistory resets sessionUsage", () => {
		conversationStore.accumulateUsage({ promptTokens: 100, completionTokens: 50 });
		conversationStore.clearHistory();
		expect(conversationStore.sessionUsage()).toBeNull();
	});

	it("sessionUsage is independent per terminal", () => {
		conversationStore.setActiveTerminal("termA");
		conversationStore.accumulateUsage({ promptTokens: 100, completionTokens: 50 });

		conversationStore.setActiveTerminal("termB");
		expect(conversationStore.sessionUsage()).toBeNull();

		conversationStore.setActiveTerminal("termA");
		expect(conversationStore.sessionUsage()?.promptTokens).toBe(100);
	});
});

describe("conversationStore — per-terminal state (1406-c679)", () => {
	beforeEach(() => {
		conversationStore.setActiveTerminal("__default__");
		conversationStore.clearHistory();
		vi.clearAllMocks();
	});

	it("getOrCreate returns independent state for different keys", () => {
		const stateA = conversationStore.getOrCreate("termA");
		const stateB = conversationStore.getOrCreate("termB");
		expect(stateA).not.toBe(stateB);
	});

	it("messages() reflects the active terminal only", () => {
		conversationStore.setActiveTerminal("termA");
		conversationStore.addUserMessage("hello from A");

		conversationStore.setActiveTerminal("termB");
		expect(conversationStore.messages()).toEqual([]);

		conversationStore.setActiveTerminal("termA");
		expect(conversationStore.messages()).toHaveLength(1);
		expect(conversationStore.messages()[0]?.content).toBe("hello from A");
	});

	it("isStreaming() is independent per terminal", () => {
		conversationStore.setActiveTerminal("termA");
		conversationStore.setStreaming(true);

		conversationStore.setActiveTerminal("termB");
		expect(conversationStore.isStreaming()).toBe(false);

		conversationStore.setActiveTerminal("termA");
		expect(conversationStore.isStreaming()).toBe(true);
	});

	it("error() is independent per terminal", () => {
		conversationStore.setActiveTerminal("termA");
		conversationStore.setError("termA error");

		conversationStore.setActiveTerminal("termB");
		expect(conversationStore.error()).toBeNull();
	});

	it("activeConversation() returns the PerTerminalConversationState for the active terminal", () => {
		conversationStore.setActiveTerminal("termX");
		const state = conversationStore.activeConversation();
		expect(typeof state.messages).toBe("function");
		expect(typeof state.isStreaming).toBe("function");
		expect(typeof state.streamingText).toBe("function");
		expect(typeof state.error).toBe("function");
		expect(typeof state.chatId).toBe("function");
	});
});
