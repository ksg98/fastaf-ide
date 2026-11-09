import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListen, mockConversationStore, mockVoiceStore, listeners, replyObserver } = vi.hoisted(() => {
	const listeners = new Map<string, (event: { payload: unknown }) => void>();
	const replyObserver: {
		current: {
			onDelta?: (t: string) => void;
			onTurnEnd?: () => void;
			onToolCall?: (name: string, args: Record<string, unknown>) => void;
		} | null;
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
			pendingApproval: vi.fn<() => { sessionId: string; command: string; reason: string } | null>(() => null),
			approveAction: vi.fn().mockResolvedValue(undefined),
			sendMessage: vi.fn().mockResolvedValue(undefined),
			startAgent: vi.fn(),
			cancelStream: vi.fn().mockResolvedValue(undefined),
			cancelAgent: vi.fn().mockResolvedValue(undefined),
			observeReply: vi.fn((observer: NonNullable<(typeof replyObserver)["current"]>) => {
				replyObserver.current = observer;
				return vi.fn();
			}),
		},
		mockVoiceStore: {
			state: { agentState: "idle", error: "", muted: false },
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

import { CHIP_MS, createTalkController, type TalkController, type TalkTarget } from "../../stores/talkController";

const TARGETS: Record<string, TalkTarget> = {
	"sess-1": { terminalId: "term-1", recipient: "Claude Code", place: "api-gateway" },
	"sess-2": { terminalId: "term-2", recipient: "Codex CLI", place: "web-dashboard" },
};

let disposers: Array<() => void> = [];

/**
 * A conversation with a chat panel lending its settings, as when AI Chat is
 * open. `panel: false` leaves it on the window's own defaults.
 */
function mount(options: { autonomy?: string; sessionId?: string | null; panel?: boolean } = {}): TalkController {
	const talk = createTalkController({
		defaultSessionId: () => "sess-front",
		describeSession: (sessionId) => TARGETS[sessionId] ?? null,
	});
	if (options.panel !== false) {
		talk.bind({
			sessionId: () => (options.sessionId === undefined ? "sess-1" : options.sessionId),
			autonomy: () => options.autonomy ?? "assisted",
			turnOptions: () => ({ modelOverride: "gpt-x", reasoningEffort: "high" }),
		});
	}
	disposers.push(talk.dispose);
	return talk;
}

/** Deliver a `voice-utterance` as Rust would, then let the controller's awaits settle. */
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
	mockConversationStore.pendingApproval.mockReturnValue(null);
	mockVoiceStore.state.agentState = "idle";
	mockVoiceStore.state.muted = false;
});

afterEach(() => {
	for (const dispose of disposers) dispose();
	disposers = [];
});

describe("talk controller: session", () => {
	it("starts inactive and does not touch the microphone until asked", () => {
		const talk = mount();
		expect(talk.active()).toBe(false);
		expect(talk.engaged()).toBe(false);
		expect(mockVoiceStore.startSession).not.toHaveBeenCalled();
	});

	it("becomes active once the session starts", async () => {
		const talk = mount();
		await talk.start();
		expect(mockVoiceStore.startSession).toHaveBeenCalledOnce();
		expect(talk.active()).toBe(true);
	});

	// Catches: the dock showing nothing for the second or more the voice engine
	// takes to load, so the click looks ignored.
	it("is on screen from the moment it is asked to start, before the session is up", async () => {
		let finish!: () => void;
		mockVoiceStore.startSession.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
		const talk = mount();

		const starting = talk.start();
		expect(talk.engaged()).toBe(true);
		expect(talk.active()).toBe(false);

		finish();
		await starting;
		expect(talk.active()).toBe(true);
		expect(talk.starting()).toBe(false);
	});

	it("does not start a second session while the first is still coming up", async () => {
		let finish!: () => void;
		mockVoiceStore.startSession.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
		const talk = mount();
		const first = talk.start();
		await talk.start();
		finish();
		await first;
		expect(mockVoiceStore.startSession).toHaveBeenCalledOnce();
	});

	it("stays inactive when the session fails to start", async () => {
		mockVoiceStore.startSession.mockRejectedValueOnce(new Error("microphone_denied"));
		const talk = mount();
		await talk.start();
		expect(talk.active()).toBe(false);
		expect(talk.engaged()).toBe(false);
	});

	it("stop releases the microphone and silences any queued speech", async () => {
		const talk = mount();
		await talk.start();
		await talk.stop();

		expect(talk.active()).toBe(false);
		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockVoiceStore.stopSession).toHaveBeenCalledOnce();
	});
});

describe("talk controller: turns", () => {
	it("routes an utterance to sendMessage in assisted mode", async () => {
		const talk = mount({ autonomy: "assisted" });
		await talk.start();
		await speakToAgent("what changed in this file");

		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("what changed in this file", "sess-1", {
			modelOverride: "gpt-x",
			reasoningEffort: "high",
		});
		expect(mockConversationStore.startAgent).not.toHaveBeenCalled();
	});

	it("routes an utterance to startAgent in autonomous mode", async () => {
		const talk = mount({ autonomy: "autonomous" });
		await talk.start();
		await speakToAgent("fix the failing test");

		expect(mockConversationStore.startAgent).toHaveBeenCalledWith("sess-1", "fix the failing test", false, {
			modelOverride: "gpt-x",
			reasoningEffort: "high",
		});
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
	});

	// Catches: talk mode started from the dock with AI Chat closed sending to no
	// session at all, which the chat answers with "No terminal attached".
	it("talks to the terminal in front, in ask mode, when no chat panel is open", async () => {
		const talk = mount({ panel: false });
		await talk.start();
		await speakToAgent("are the tests green");

		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("are the tests green", "sess-front", {});
	});

	// Catches: a panel that closed still deciding where turns go.
	it("uses the open panel's settings, and the window's own again once it closes", async () => {
		const talk = mount({ panel: false });
		const unbind = talk.bind({
			sessionId: () => "sess-panel",
			autonomy: () => "assisted",
			turnOptions: () => ({ modelOverride: "panel-model" }),
		});
		await talk.start();
		await speakToAgent("first");
		expect(mockConversationStore.sendMessage).toHaveBeenLastCalledWith("first", "sess-panel", {
			modelOverride: "panel-model",
		});

		unbind();
		mockConversationStore.sendMessage.mockClear();
		await speakToAgent("second");
		expect(mockConversationStore.sendMessage).toHaveBeenLastCalledWith("second", "sess-front", {});
	});

	it("ignores utterances while inactive, so a stale event cannot send a turn", async () => {
		mount();
		listeners.get("voice-utterance")?.({ payload: { text: "should be ignored" } });
		await Promise.resolve();
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
	});

	it("ignores an empty transcript", async () => {
		const talk = mount();
		await talk.start();
		listeners.get("voice-utterance")?.({ payload: { text: "   " } });
		await Promise.resolve();
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
	});

	it("speaks each sentence as the reply streams", async () => {
		const talk = mount();
		await talk.start();

		replyObserver.current?.onDelta?.("The build finished without errors. ");
		expect(mockVoiceStore.speak).toHaveBeenCalledWith("The build finished without errors.");

		// A partial sentence waits for the boundary rather than being spoken.
		mockVoiceStore.speak.mockClear();
		replyObserver.current?.onDelta?.("Nothing else to");
		expect(mockVoiceStore.speak).not.toHaveBeenCalled();

		// ...and the remainder goes out when the turn ends.
		replyObserver.current?.onTurnEnd?.();
		expect(mockVoiceStore.speak).toHaveBeenCalledWith("Nothing else to");
	});

	it("does not speak replies when the conversation is off", () => {
		mount();
		replyObserver.current?.onDelta?.("A complete sentence that would be spoken. ");
		expect(mockVoiceStore.speak).not.toHaveBeenCalled();
	});

	it("barge-in cancels speech and the streaming turn in assisted mode", async () => {
		const talk = mount({ autonomy: "assisted" });
		await talk.start();
		mockConversationStore.isStreaming.mockReturnValue(true);

		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).toHaveBeenCalled();
	});

	it("barge-in cancels the agent in autonomous mode", async () => {
		const talk = mount({ autonomy: "autonomous" });
		await talk.start();
		mockConversationStore.agentState.mockReturnValue("running");

		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockConversationStore.cancelAgent).toHaveBeenCalledWith("sess-1");
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
	});

	it("barge-in still silences audio when no turn is in flight", async () => {
		const talk = mount();
		await talk.start();
		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
	});

	it("drops an utterance rather than queueing it when the chat stays busy", async () => {
		vi.useFakeTimers();
		try {
			const talk = mount();
			await talk.start();
			mockConversationStore.isStreaming.mockReturnValue(true);

			listeners.get("voice-utterance")?.({ payload: { text: "spoken while busy" } });
			await vi.advanceTimersByTimeAsync(5000);

			expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends an utterance once an in-flight turn finishes", async () => {
		vi.useFakeTimers();
		try {
			const talk = mount();
			await talk.start();
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
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("talk controller while muted", () => {
	it("drops an utterance that lands after the mute", async () => {
		const talk = mount();
		await talk.start();
		mockVoiceStore.state.muted = true;

		// Rust stops feeding the detector the moment the flag flips, but a turn
		// that already finished transcribing is on its way here regardless.
		listeners.get("voice-utterance")?.({ payload: { text: "thinking out loud" } });
		await Promise.resolve();

		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		// Nothing that was dropped may be shown as heard either.
		expect(talk.caption()).toBeNull();
	});

	it("resumes sending once unmuted", async () => {
		const talk = mount();
		await talk.start();
		mockVoiceStore.state.muted = true;
		listeners.get("voice-utterance")?.({ payload: { text: "dropped" } });
		await Promise.resolve();

		mockVoiceStore.state.muted = false;
		await speakToAgent("heard");

		expect(mockConversationStore.sendMessage).toHaveBeenCalledOnce();
		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("heard", "sess-1", expect.anything());
	});

	it("keeps speaking the reply — mute is the microphone, not the agent", async () => {
		const talk = mount();
		await talk.start();
		mockVoiceStore.state.muted = true;

		replyObserver.current?.onDelta?.("Here is the answer. ");

		expect(mockVoiceStore.speak).toHaveBeenCalledWith("Here is the answer.");
	});
});

describe("talk controller: what the dock shows", () => {
	it("captions what you said, then what it says, sentence by sentence", async () => {
		const talk = mount();
		await talk.start();
		expect(talk.caption()).toBeNull();

		await speakToAgent("are the tests green");
		expect(talk.caption()).toEqual({ who: "you", text: "are the tests green" });

		replyObserver.current?.onDelta?.("Yes, all fourteen pass. ");
		expect(talk.caption()).toEqual({ who: "agent", text: "Yes, all fourteen pass." });

		replyObserver.current?.onDelta?.("Three of them are new. ");
		expect(talk.caption()).toEqual({ who: "agent", text: "Yes, all fourteen pass. Three of them are new." });
	});

	// Catches: the dock saying only "Listening" for the whole of a long sentence,
	// which reads as "not sure it is working" until the turn ends.
	it("shows your words while you are still saying them, then the finished sentence", async () => {
		const talk = mount();
		await talk.start();

		listeners.get("voice-partial")?.({ payload: { text: "tell the api gateway" } });
		expect(talk.caption()).toEqual({ who: "you", text: "tell the api gateway" });
		// A caption is only a caption: nothing is sent until the turn ends.
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();

		listeners.get("voice-partial")?.({ payload: { text: "tell the api gateway Claude to retry" } });
		expect(talk.caption()?.text).toBe("tell the api gateway Claude to retry");

		await speakToAgent("Tell the api-gateway Claude to retry 503s.");
		expect(talk.caption()).toEqual({ who: "you", text: "Tell the api-gateway Claude to retry 503s." });
	});

	it("takes the words over from a reply the moment you start talking across it", async () => {
		const talk = mount();
		await talk.start();
		replyObserver.current?.onDelta?.("Here is a long answer about it. ");

		listeners.get("voice-partial")?.({ payload: { text: "wait" } });
		expect(talk.caption()).toEqual({ who: "you", text: "wait" });

		// The reply it interrupted does not get its old sentences back.
		replyObserver.current?.onDelta?.("A new answer begins here. ");
		expect(talk.caption()).toEqual({ who: "agent", text: "A new answer begins here." });
	});

	it("ignores captions while off or muted — nothing heard then may be shown", async () => {
		const talk = mount();
		listeners.get("voice-partial")?.({ payload: { text: "before it started" } });
		expect(talk.caption()).toBeNull();

		await talk.start();
		mockVoiceStore.state.muted = true;
		listeners.get("voice-partial")?.({ payload: { text: "said while muted" } });
		expect(talk.caption()).toBeNull();
	});

	// Catches: the caption of the next reply starting with the whole previous one.
	it("starts a fresh caption for each reply", async () => {
		const talk = mount();
		await talk.start();
		replyObserver.current?.onDelta?.("First answer here now. ");
		replyObserver.current?.onTurnEnd?.();

		replyObserver.current?.onDelta?.("Second answer here now. ");
		expect(talk.caption()).toEqual({ who: "agent", text: "Second answer here now." });
	});

	it("shows a chip, naming the terminal, when it sends something to an agent", async () => {
		const talk = mount();
		await talk.start();

		replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-2", command: "run the tests" });

		expect(talk.chips()).toHaveLength(1);
		expect(talk.chips()[0]).toMatchObject({ kind: "sent", target: TARGETS["sess-2"] });
	});

	// Catches: nothing on screen connecting "I said it" to the terminal it landed in.
	it("points the window at the terminal it acted in, and at nothing for one it cannot name", async () => {
		const onAction = vi.fn();
		const talk = createTalkController({
			defaultSessionId: () => "sess-front",
			describeSession: (sessionId) => TARGETS[sessionId] ?? null,
			onAction,
		});
		disposers.push(talk.dispose);
		await talk.start();

		replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-2", command: "run the tests" });
		expect(onAction).toHaveBeenCalledWith(TARGETS["sess-2"]);

		onAction.mockClear();
		replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-unknown", command: "ls" });
		expect(onAction).not.toHaveBeenCalled();
	});

	// Catches: a chip for every screen read, which is most of what the agent does.
	it("stays quiet about calls that only read", async () => {
		const talk = mount();
		await talk.start();

		replyObserver.current?.onToolCall?.("read_screen", { session_id: "sess-2" });
		replyObserver.current?.onToolCall?.("wait_for", { session_id: "sess-2" });
		replyObserver.current?.onToolCall?.("list_sessions", {});
		replyObserver.current?.onToolCall?.("drive_agent", { session_id: "sess-2" });

		expect(talk.chips()).toHaveLength(0);
	});

	it("names the key it pressed and the command it sent through drive_agent", async () => {
		const talk = mount();
		await talk.start();

		replyObserver.current?.onToolCall?.("send_key", { session_id: "sess-1", key: "enter" });
		replyObserver.current?.onToolCall?.("drive_agent", { session_id: "sess-2", command: "continue" });

		expect(talk.chips().map((chip) => [chip.kind, chip.detail, chip.target?.terminalId])).toEqual([
			["key", "enter", "term-1"],
			["sent", undefined, "term-2"],
		]);
	});

	it("does not make chips while the conversation is off", () => {
		const talk = mount();
		replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-2", command: "ls" });
		expect(talk.chips()).toHaveLength(0);
	});

	it("takes a chip down after a few seconds and never shows more than three", async () => {
		vi.useFakeTimers();
		try {
			const talk = mount();
			await talk.start();
			for (let i = 0; i < 5; i++) {
				replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-1", command: `step ${i}` });
			}
			expect(talk.chips()).toHaveLength(3);

			await vi.advanceTimersByTimeAsync(CHIP_MS + 50);
			expect(talk.chips()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears the caption and chips when the conversation ends", async () => {
		const talk = mount();
		await talk.start();
		await speakToAgent("hello there");
		replyObserver.current?.onToolCall?.("send_input", { session_id: "sess-1", command: "ls" });

		await talk.stop();

		expect(talk.caption()).toBeNull();
		expect(talk.chips()).toHaveLength(0);
	});
});

describe("talk controller: FastAF speaks first", () => {
	it("says a notice through the running conversation, under its own caption", async () => {
		const talk = mount();
		await talk.start();
		replyObserver.current?.onDelta?.("An earlier answer to something. ");

		talk.announce("Claude Code in ml-pipeline needs you.");

		expect(mockVoiceStore.speak).toHaveBeenLastCalledWith("Claude Code in ml-pipeline needs you.");
		expect(talk.caption()).toEqual({ who: "agent", text: "Claude Code in ml-pipeline needs you." });

		// The reply that follows does not run on from the notice.
		replyObserver.current?.onDelta?.("Now the next answer. ");
		expect(talk.caption()).toEqual({ who: "agent", text: "Now the next answer." });
	});

	it("says nothing through a conversation that is not running", () => {
		const talk = mount();
		talk.announce("Claude Code is done.");
		expect(mockVoiceStore.speak).not.toHaveBeenCalled();
		expect(talk.caption()).toBeNull();
	});

	it("gives a spoken yes or no to the agent whose question was read out", async () => {
		const answer = vi.fn();
		const talk = createTalkController({
			defaultSessionId: () => "sess-front",
			describeSession: (sessionId) => TARGETS[sessionId] ?? null,
			ask: () => ({ target: TARGETS["sess-2"], answer }),
		});
		disposers.push(talk.dispose);
		await talk.start();

		listeners.get("voice-utterance")?.({ payload: { text: "Approve it." } });
		await vi.waitFor(() => expect(answer).toHaveBeenCalledWith(true));

		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		expect(talk.chips()[0]).toMatchObject({ kind: "approved", target: TARGETS["sess-2"] });
	});

	// Catches: a waiting question swallowing everything said until it is answered.
	it("still sends ordinary sentences while an agent's question waits", async () => {
		const answer = vi.fn();
		const talk = createTalkController({
			defaultSessionId: () => "sess-front",
			describeSession: (sessionId) => TARGETS[sessionId] ?? null,
			ask: () => ({ target: TARGETS["sess-2"], answer }),
		});
		disposers.push(talk.dispose);
		await talk.start();

		await speakToAgent("what is it trying to delete");

		expect(answer).not.toHaveBeenCalled();
		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("what is it trying to delete", "sess-front", {});
	});
});

describe("talk controller: answering an approval out loud", () => {
	const pending = { sessionId: "sess-1", command: "rm -rf data/cache", reason: "destructive" };

	it("approves on a spoken yes instead of sending it as a message", async () => {
		const talk = mount();
		await talk.start();
		mockConversationStore.pendingApproval.mockReturnValue(pending);
		mockConversationStore.isStreaming.mockReturnValue(true);

		listeners.get("voice-utterance")?.({ payload: { text: "Approve." } });
		await vi.waitFor(() => expect(mockConversationStore.approveAction).toHaveBeenCalled());

		expect(mockConversationStore.approveAction).toHaveBeenCalledWith("sess-1", true);
		expect(mockConversationStore.sendMessage).not.toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
		expect(talk.chips()[0]).toMatchObject({ kind: "approved", target: TARGETS["sess-1"] });
	});

	it("denies on a spoken no", async () => {
		const talk = mount();
		await talk.start();
		mockConversationStore.pendingApproval.mockReturnValue(pending);

		listeners.get("voice-utterance")?.({ payload: { text: "no" } });
		await vi.waitFor(() => expect(mockConversationStore.approveAction).toHaveBeenCalled());

		expect(mockConversationStore.approveAction).toHaveBeenCalledWith("sess-1", false);
		expect(talk.chips()[0]).toMatchObject({ kind: "denied" });
	});

	// Catches: saying "approve" cancelling the very turn that asked for it —
	// speech start is a barge-in, and an approval keeps the turn streaming.
	it("does not cancel the waiting turn when you start to answer", async () => {
		const talk = mount();
		await talk.start();
		mockConversationStore.pendingApproval.mockReturnValue(pending);
		mockConversationStore.isStreaming.mockReturnValue(true);

		listeners.get("voice-speech-start")?.({ payload: {} });

		expect(mockVoiceStore.cancelSpeech).toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).not.toHaveBeenCalled();
	});

	// Catches: "no, use the staging database instead" being read as a bare no.
	it("treats anything longer as a new instruction that replaces the request", async () => {
		const talk = mount();
		await talk.start();
		mockConversationStore.pendingApproval.mockReturnValue(pending);
		mockConversationStore.isStreaming.mockReturnValue(true);
		mockConversationStore.cancelStream.mockImplementation(async () => {
			mockConversationStore.isStreaming.mockReturnValue(false);
			mockConversationStore.pendingApproval.mockReturnValue(null);
		});

		await speakToAgent("no, use the staging database instead");

		expect(mockConversationStore.approveAction).not.toHaveBeenCalled();
		expect(mockConversationStore.cancelStream).toHaveBeenCalled();
		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith(
			"no, use the staging database instead",
			"sess-1",
			expect.anything(),
		);
	});

	it("does not read a plain yes as an approval when nothing is waiting", async () => {
		const talk = mount();
		await talk.start();

		await speakToAgent("yes");

		expect(mockConversationStore.approveAction).not.toHaveBeenCalled();
		expect(mockConversationStore.sendMessage).toHaveBeenCalledWith("yes", "sess-1", expect.anything());
	});
});
