import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Upstream 2.0.1–2.1.2 chat behaviour on FastAF's own engine: a submitted turn
 * is "sending" until the backend takes it, a turn that got no answer keeps its
 * payload for a retry, and a conversation can be started anew, cleared from
 * view or branched without anything saved being lost.
 */

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
	Channel: class {
		onmessage: ((_msg: unknown) => void) | null = null;
	},
}));

vi.mock("../../transport", () => ({
	isTauri: () => true,
	owningConnectionFor: () => undefined,
	rpc: vi.fn(async () => ({})),
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

type Store = typeof import("../../stores/conversationStore").conversationStore;
type Saved = {
	meta: { id: string; title: string; message_count: number };
	messages: { role: string; content: string }[];
};

describe("conversationStore turns, forks and clears", () => {
	let store: Store;
	/** Channels of started conversations, newest last. */
	let channels: { onmessage: ((msg: unknown) => void) | null }[];
	let saved: Saved[];
	/** How `start_conversation` answers: resolve, reject, or stay pending until released. */
	let start: "accept" | "reject" | "hang";
	let release: () => void;
	let ids: number;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset();
		channels = [];
		saved = [];
		start = "accept";
		release = () => {};
		ids = 0;
		mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
			if (cmd === "start_conversation") {
				channels.push(args?.onEvent as (typeof channels)[number]);
				if (start === "reject") return Promise.reject("Conversation already active on session sess-1");
				if (start === "hang") {
					return new Promise<void>((resolve) => {
						const earlier = release;
						release = () => {
							earlier();
							resolve();
						};
					});
				}
				return Promise.resolve();
			}
			if (cmd === "save_conversation") {
				saved.push(structuredClone(args?.conversation) as Saved);
				return Promise.resolve();
			}
			if (cmd === "new_conversation_id") return Promise.resolve(`conv-${++ids}`);
			if (cmd === "load_conversation") {
				const found = saved.findLast((conv) => conv.meta.id === args?.id);
				return found ? Promise.resolve(structuredClone(found)) : Promise.reject(new Error("not found"));
			}
			return Promise.resolve();
		});
		store = (await import("../../stores/conversationStore")).conversationStore;
		store.setActiveTerminal("T1");
	});

	afterEach(async () => {
		// Let a turn a test left pending reach the backend and settle, so nothing outlives its test.
		for (let round = 0; round < 3; round++) {
			await vi.advanceTimersByTimeAsync(0);
			release();
		}
		await vi.advanceTimersByTimeAsync(0);
		vi.useRealTimers();
	});

	const emit = (event: unknown) => channels.at(-1)?.onmessage?.(event);
	const flushSave = () => vi.advanceTimersByTimeAsync(600);
	/** One completed exchange in the thread. */
	const exchange = async (question: string, answer: string) => {
		await store.sendMessage(question, "sess-1");
		emit({ type: "text_chunk", text: answer });
		emit({ type: "completed", reason: "end_turn", usage: null });
	};

	describe("sending", () => {
		// Catches: a turn the backend has not taken yet looking delivered, or being saved as history.
		it("is sending until the backend takes the turn, and is saved only after that", async () => {
			start = "hang";
			const sent = store.sendMessage("hello", "sess-1", { modelOverride: "m-1" });
			expect(store.messages()).toMatchObject([{ role: "user", content: "hello", delivery: "sending" }]);
			await flushSave();
			expect(saved).toHaveLength(0);

			release();
			await sent;
			expect(store.messages()[0].delivery).toBeUndefined();
			await flushSave();
			expect(saved.at(-1)?.messages).toMatchObject([{ role: "user", content: "hello" }]);
		});

		// Over a WebSocket there is no command answer at all; on the desktop an event can overtake it.
		it("takes the first stream event as proof the turn was taken", async () => {
			start = "hang";
			void store.sendMessage("hello", "sess-1");
			await vi.advanceTimersByTimeAsync(0);
			emit({ type: "thinking", iteration: 0 });
			expect(store.messages()[0].delivery).toBeUndefined();
		});
	});

	describe("a turn that got no answer", () => {
		// Catches: the question lost, saved as if delivered, or doubled by a retry.
		it("keeps a refused send with its reason and its options, out of the saved history", async () => {
			await exchange("first", "an answer");
			start = "reject";
			await store.sendMessage("second", "sess-1", { modelOverride: "m-1", reasoningEffort: "high" });

			const failed = store.messages().at(-1);
			expect(failed).toMatchObject({
				content: "second",
				delivery: "not_sent",
				failure: "Conversation already active on session sess-1",
				turn: { modelOverride: "m-1", reasoningEffort: "high" },
			});
			expect(store.isStreaming()).toBe(false);
			expect(store.error()).toBe("Conversation already active on session sess-1");
			await flushSave();
			expect(saved.at(-1)?.messages.map((m) => m.content)).toEqual(["first", "an answer"]);
		});

		it("retries with the same text and options, once, at the end of the thread", async () => {
			start = "reject";
			await store.sendMessage("second", "sess-1", { modelOverride: "m-1", reasoningEffort: "high" });
			const failedId = store.messages()[0].localId as number;
			store.addAssistantMessage("something later");

			start = "accept";
			mockInvoke.mockClear();
			await store.retryMessage(failedId, "sess-1");

			expect(mockInvoke).toHaveBeenCalledWith(
				"start_conversation",
				expect.objectContaining({ message: "second", modelOverride: "m-1", reasoningEffort: "high" }),
			);
			expect(store.messages().map((m) => m.content)).toEqual(["something later", "second"]);
			expect(store.messages().at(-1)?.delivery).toBeUndefined();
			expect(store.error()).toBeNull();
		});

		it("marks a turn the provider failed as No reply, and lets it be discarded", async () => {
			await store.sendMessage("why", "sess-1");
			emit({ type: "thinking", iteration: 0 });
			emit({ type: "error", message: "HTTP 401: invalid key" });

			const failed = store.messages()[0];
			expect(failed).toMatchObject({ delivery: "no_reply", failure: "HTTP 401: invalid key" });
			expect(store.isStreaming()).toBe(false);

			store.discardMessage(failed.localId as number);
			expect(store.messages()).toEqual([]);
			expect(store.error()).toBeNull();
		});

		it("does not retry while another turn is running", async () => {
			start = "reject";
			await store.sendMessage("second", "sess-1");
			const failedId = store.messages()[0].localId as number;
			start = "hang";
			void store.sendMessage("third", "sess-1");
			mockInvoke.mockClear();
			await store.retryMessage(failedId, "sess-1");
			expect(mockInvoke).not.toHaveBeenCalledWith("start_conversation", expect.anything());
			expect(store.messages().map((m) => m.content)).toEqual(["second", "third"]);
		});
	});

	describe("chat state", () => {
		// Catches the bug this replaced: one Ask turn left the chat "Agent running"
		// for good, and Agent mode then refused to start.
		it("does not turn an Ask turn into an agent run", async () => {
			await store.sendMessage("why", "sess-1");
			emit({ type: "thinking", iteration: 0 });
			expect(store.agentState()).toBe("idle");
			expect(store.chatActivity()).toBe("working");

			emit({ type: "text_chunk", text: "because" });
			emit({ type: "completed", reason: "end_turn", usage: null });
			expect(store.agentState()).toBe("idle");
			expect(store.chatActivity()).toBe("idle");

			await store.startAgent("sess-1", "do it");
			expect(store.agentState()).toBe("running");
		});

		it("is waiting while an approval is open or the run is paused, working while it runs", async () => {
			await store.startAgent("sess-1", "do it");
			emit({ type: "thinking", iteration: 0 });
			expect(store.chatActivity()).toBe("working");
			emit({ type: "needs_approval", tool_name: "run", command: "rm -rf x", reason: "", approval_id: "a1" });
			expect(store.chatActivity()).toBe("waiting");
			await store.approveAction("sess-1", true);
			expect(store.chatActivity()).toBe("working");
			emit({ type: "paused" });
			expect(store.chatActivity()).toBe("waiting");
		});

		// One chat's work never marks another chat busy.
		it("keeps each terminal's chat to its own state, and finds a chat by its conversation id", async () => {
			start = "hang";
			void store.sendMessage("why", "sess-1");
			const busyId = store.chatId();
			store.setActiveTerminal("T2");
			expect(store.chatActivity()).toBe("idle");
			expect(store.chatActivityOf(busyId)).toBe("working");
			expect(store.chatActivityOf("some-other-conversation")).toBe("idle");
		});

		it("starts a failed agent task again with what it was submitted with", async () => {
			await store.startAgent("sess-1", "bump the floor", true, { modelOverride: "m-1" });
			emit({ type: "error", message: "HTTP 529" });
			expect(store.agentState()).toBe("error");
			expect(store.agentGoal()).toMatchObject({ goal: "bump the floor", unrestricted: true });

			mockInvoke.mockClear();
			await store.retryAgent("sess-1");
			expect(mockInvoke).toHaveBeenCalledWith(
				"start_conversation",
				expect.objectContaining({ message: "bump the floor", bypassedTools: ["*"], modelOverride: "m-1" }),
			);
			expect(store.agentState()).toBe("running");
		});
	});

	describe("new conversation", () => {
		// Catches: /clear deleting the conversation, or reusing its id and overwriting it.
		it("saves the conversation on screen, then starts an empty one under a new id", async () => {
			await exchange("first", "an answer");
			const oldId = store.chatId();
			mockInvoke.mockClear();

			await expect(store.newConversation()).resolves.toBe("started");

			expect(store.messages()).toEqual([]);
			expect(store.chatId()).toBe("conv-1");
			expect(saved.at(-1)).toMatchObject({ meta: { id: oldId, message_count: 2 } });
			expect(mockInvoke).not.toHaveBeenCalledWith("delete_conversation", expect.anything());
		});

		it("is refused while a turn is running", async () => {
			start = "hang";
			void store.sendMessage("why", "sess-1");
			const id = store.chatId();
			await expect(store.newConversation()).resolves.toBe("busy");
			expect(store.chatId()).toBe(id);
			expect(store.messages()).toHaveLength(1);
		});

		it("has nothing to do in a conversation that is already empty", async () => {
			const id = store.chatId();
			await expect(store.newConversation()).resolves.toBe("empty");
			expect(store.chatId()).toBe(id);
		});
	});

	describe("clear view", () => {
		// Catches: the view clear deleting messages, dropping them from the next save, or resetting the conversation.
		it("hides the messages without removing them from the conversation or its saved history", async () => {
			await exchange("first", "an answer");
			const id = store.chatId();
			saved.length = 0;

			expect(store.clearView()).toBe(true);
			expect(store.visibleMessages()).toEqual([]);
			expect(store.messages()).toHaveLength(2);
			expect(store.chatId()).toBe(id);

			await exchange("second", "another answer");
			expect(store.visibleMessages().map((m) => m.content)).toEqual(["second", "another answer"]);
			await flushSave();
			expect(saved.at(-1)?.messages.map((m) => m.content)).toEqual(["first", "an answer", "second", "another answer"]);
		});

		it("shows everything again when the conversation is opened from History", async () => {
			await exchange("first", "an answer");
			await flushSave();
			store.clearView();
			await store.loadConversation(store.chatId());
			expect(store.visibleMessages().map((m) => m.content)).toEqual(["first", "an answer"]);
		});

		it("reports that there was nothing to clear", () => {
			expect(store.clearView()).toBe(false);
		});
	});

	describe("fork", () => {
		// Catches: a fork that cuts in the wrong place, loses the original, or is indistinguishable from it in History.
		it("opens a new conversation with the turns up to the chosen answer and keeps the original", async () => {
			await exchange("first", "answer one");
			await exchange("second", "answer two");
			const original = store.chatId();
			const cut = store.messages()[1].localId;

			await expect(store.forkConversation(cut)).resolves.toBe("forked");

			expect(store.chatId()).toBe("conv-1");
			expect(store.messages().map((m) => m.content)).toEqual(["first", "answer one"]);
			expect(saved.find((conv) => conv.meta.id === original)?.messages).toHaveLength(4);
			expect(saved.findLast((conv) => conv.meta.id === "conv-1")).toMatchObject({
				meta: { title: "Fork: first", message_count: 2 },
			});
		});

		it("keeps the fork's title when it is saved again, and does not stack the prefix on a fork of a fork", async () => {
			await exchange("first", "answer one");
			await store.forkConversation();
			await exchange("second", "answer two");
			await flushSave();
			expect(saved.at(-1)?.meta.title).toBe("Fork: first");

			await store.forkConversation();
			expect(saved.at(-1)?.meta.title).toBe("Fork: first");
		});

		// Upstream: "partial output, failed turns and cancellation never become automatic cutoffs".
		it("cuts at the last completed answer and leaves out a turn that failed or is still being sent", async () => {
			await exchange("first", "answer one");
			start = "reject";
			await store.sendMessage("refused", "sess-1");

			await expect(store.forkConversation()).resolves.toBe("forked");
			expect(store.messages().map((m) => m.content)).toEqual(["first", "answer one"]);
		});

		// One conversation runs per terminal: the running turn keeps the screen, the branch goes to History.
		it("saves the branch to History and leaves the screen alone while a turn is running", async () => {
			await exchange("first", "answer one");
			const original = store.chatId();
			start = "hang";
			void store.sendMessage("still running", "sess-1");
			emit({ type: "text_chunk", text: "partial out" });

			await expect(store.forkConversation()).resolves.toBe("saved");

			expect(store.chatId()).toBe(original);
			expect(store.isStreaming()).toBe(true);
			expect(store.messages()).toHaveLength(3);
			expect(saved.findLast((conv) => conv.meta.id === "conv-1")?.messages.map((m) => m.content)).toEqual([
				"first",
				"answer one",
			]);
		});

		it("has nothing to fork before the first completed answer", async () => {
			start = "hang";
			void store.sendMessage("why", "sess-1");
			await expect(store.forkConversation()).resolves.toBe("nothing");
			expect(saved).toHaveLength(0);
		});

		it("reports a branch that could not be saved and stays where it was", async () => {
			await exchange("first", "answer one");
			const original = store.chatId();
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "save_conversation") return Promise.reject(new Error("disk full"));
				if (cmd === "new_conversation_id") return Promise.resolve("conv-9");
				return Promise.resolve();
			});
			await expect(store.forkConversation()).resolves.toBe("failed");
			expect(store.chatId()).toBe(original);
		});
	});

	describe("saved titles", () => {
		// An attached image is a path marker in the text; it used to become the title.
		it("titles a conversation from the words of its first turn, not from an image path", async () => {
			await exchange("[image: /Users/me/shots/run.png]\nWhy does it hang?", "an answer");
			await flushSave();
			expect(saved.at(-1)?.meta.title).toBe("Why does it hang?");
		});

		it("calls an image-only first turn Image", async () => {
			await exchange("[image: /Users/me/shots/run.png]", "an answer");
			await flushSave();
			expect(saved.at(-1)?.meta.title).toBe("Image");
		});
	});
});
