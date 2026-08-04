import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListen, mockConversationStore, mockVoiceStore, listeners, replyObserver } = vi.hoisted(() => {
	const listeners = new Map<string, (event: { payload: unknown }) => void>();
	const replyObserver: {
		current: { onDelta?: (t: string) => void; onTurnEnd?: () => void } | null;
	} = { current: null };
	return {
		listeners,
		replyObserver,
		mockListen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
			listeners.set(event, handler);
			return Promise.resolve(vi.fn());
		}),
		mockConversationStore: {
			isStreaming: vi.fn(() => false),
			agentState: vi.fn(() => "idle"),
			unrestricted: vi.fn(() => false),
			sendMessage: vi.fn().mockResolvedValue(undefined),
			startAgent: vi.fn(),
			cancelStream: vi.fn().mockResolvedValue(undefined),
			cancelAgent: vi.fn().mockResolvedValue(undefined),
			observeReply: vi.fn((observer: { onDelta?: (t: string) => void; onTurnEnd?: () => void }) => {
				replyObserver.current = observer;
				return vi.fn();
			}),
		},
		mockVoiceStore: {
			state: { agentState: "idle", error: "" },
			startSession: vi.fn().mockResolvedValue(undefined),
			stopSession: vi.fn().mockResolvedValue(undefined),
			speak: vi.fn(),
			cancelSpeech: vi.fn(),
			setAgentState: vi.fn(),
		},
	};
});

vi.mock("../../invoke", () => ({ listen: mockListen, invoke: vi.fn() }));
vi.mock("../../stores/conversationStore", () => ({ conversationStore: mockConversationStore }));
vi.mock("../../stores/voice", () => ({ voiceStore: mockVoiceStore }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { useVoiceAgent } from "../../hooks/useVoiceAgent";

/** Mount the hook with controllable deps and return its API plus a disposer. */
function mount(options: { autonomy?: string; sessionId?: string | null } = {}) {
	let api!: ReturnType<typeof useVoiceAgent>;
	const dispose = createRoot((dispose) => {
		api = useVoiceAgent({
			sessionId: () => options.sessionId ?? "sess-1",
			autonomy: () => options.autonomy ?? "assisted",
			turnOptions: () => ({ modelOverride: "gpt-x", reasoningEffort: "high" }),
		});
		return dispose;
	});
	return { api, dispose };
}

/** Deliver a `voice-utterance` as Rust would, then let the hook's awaits settle. */
async function speakToAgent(text: string) {
	listeners.get("voice-utterance")?.({ payload: { text } });
	await vi.waitFor(() => {
		expect(
			mockConversationStore.sendMessage.mock.calls.length + mockConversationStore.startAgent.mock.calls.length,
		).toBeGreaterThan(0);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	listeners.clear();
	replyObserver.current = null;
	mockConversationStore.isStreaming.mockReturnValue(false);
	mockConversationStore.agentState.mockReturnValue("idle");
	mockVoiceStore.state.agentState = "idle";
});

describe("useVoiceAgent", () => {
	it("starts inactive and does not touch the microphone until asked", () => {
		const { api, dispose } = mount();
		expect(api.active()).toBe(false);
		expect(mockVoiceStore.startSession).not.toHaveBeenCalled();
		dispose();
	});

	it("becomes active once the session starts", async () => {
		const { api, dispose } = mount();
		await api.start();
		expect(mockVoiceStore.startSession).toHaveBeenCalledOnce();
		expect(api.active()).toBe(true);
		dispose();
	});

	it("stays inactive when the session fails to start", async () => {
		mockVoiceStore.startSession.mockRejectedValueOnce(new Error("microphone_denied"));
		const { api, dispose } = mount();
		await api.start();
		expect(api.active()).toBe(false);
		dispose();
	});

	it("routes an utterance to sendMessage in assisted mode", async () => {
		const { api, dispose } = mount({ autonomy: "assisted" });
		await api.start();
		await speakToAgent("what changed in this file");

		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("what changed in this file", "sess-1", {
			modelOverride: "gpt-x",
			reasoningEffort: "high",
		});
		expect(mockConversationStore.startAgent).not.toHaveBeenCalled();
		dispose();
	});

	it("routes an utterance to startAgent in autonomous mode", async () => {
		const { api, dispose } = mount({ autonomy: "autonomous" });
		await api.start();
		await speakToAgent("fix the failing test");

		expect(mockConversationStore.startAgent).toHaveBeenCalledWith("sess-1", "fix the failing test", false, {
			modelOverride: "gpt-x",
			reasoningEffort: "high",
		});
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		dispose();
	});

	it("ignores utterances while inactive, so a stale event cannot send a turn", async () => {
		const { dispose } = mount();
		listeners.get("voice-utterance")?.({ payload: { text: "should be ignored" } });
		await Promise.resolve();
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		dispose();
	});

	it("ignores an empty transcript", async () => {
		const { api, dispose } = mount();
		await api.start();
		listeners.get("voice-utterance")?.({ payload: { text: "   " } });
		await Promise.resolve();
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		dispose();
	});

	it("speaks each sentence as the reply streams", async () => {
		const { api, dispose } = mount();
		await api.start();

		replyObserver.current?.onDelta?.("The build finished without errors. ");
		expect(mockVoiceStore.speak).toHaveBeenCalledWith("The build finished without errors.");

		// A partial sentence waits for the boundary rather than being spoken.
		mockVoiceStore.speak.mockClear();
		replyObserver.current?.onDelta?.("Nothing else to");
		expect(mockVoiceStore.speak).not.toHaveBeenCalled();

		// ...and the remainder goes out when the turn ends.
		replyObserver.current?.onTurnEnd?.();
		expect(mockVoiceStore.speak).toHaveBeenCalledWith("Nothing else to");
		dispose();
	});

	it("does not speak replies when voice mode is off", () => {
		const { dispose } = mount();
		replyObserver.current?.onDelta?.("A complete sentence that would be spoken. ");
		expect(mockVoiceStore.speak).not.toHaveBeenCalled();
		dispose();
	});

	it("barge-in cancels speech and the streaming turn in assisted mode", async () => {
		const { api, dispose } = mount({ autonomy: "assisted" });
		await api.start();
		mockConversationStore.isStreaming.mockReturnValue(true);

		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).toHaveBeenCalled();
		dispose();
	});

	it("barge-in cancels the agent in autonomous mode", async () => {
		const { api, dispose } = mount({ autonomy: "autonomous" });
		await api.start();
		mockConversationStore.agentState.mockReturnValue("running");

		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockConversationStore.cancelAgent).toHaveBeenCalledWith("sess-1");
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
		dispose();
	});

	it("barge-in still silences audio when no turn is in flight", async () => {
		const { api, dispose } = mount();
		await api.start();
		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
		dispose();
	});

	it("stop releases the microphone and silences any queued speech", async () => {
		const { api, dispose } = mount();
		await api.start();
		await api.stop();

		expect(api.active()).toBe(false);
		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockVoiceStore.stopSession).toHaveBeenCalledOnce();
		dispose();
	});

	it("disposing an active session releases the microphone", async () => {
		const { api, dispose } = mount();
		await api.start();
		dispose();
		await vi.waitFor(() => expect(mockVoiceStore.stopSession).toHaveBeenCalled());
	});

	it("drops an utterance rather than queueing it when the chat stays busy", async () => {
		vi.useFakeTimers();
		try {
			const { api, dispose } = mount();
			await api.start();
			mockConversationStore.isStreaming.mockReturnValue(true);

			listeners.get("voice-utterance")?.({ payload: { text: "spoken while busy" } });
			await vi.advanceTimersByTimeAsync(5000);

			expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
			dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends an utterance once an in-flight turn finishes", async () => {
		vi.useFakeTimers();
		try {
			const { api, dispose } = mount();
			await api.start();
			mockConversationStore.isStreaming.mockReturnValue(true);

			listeners.get("voice-utterance")?.({ payload: { text: "queued behind a turn" } });
			await vi.advanceTimersByTimeAsync(500);
			expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();

			mockConversationStore.isStreaming.mockReturnValue(false);
			await vi.advanceTimersByTimeAsync(500);

			expect(mockConversationStore.sendMessage).toHaveBeenCalledWith(
				"queued behind a turn",
				"sess-1",
				expect.anything(),
			);
			dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
