import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockSubscribe,
	mockUnsubscribe,
	mockChatId,
	mockDetachPanel,
	mockReattachPanel,
	mockClosePanel,
	mockReasoningChunks,
	mockIsThinking,
	mockMessages,
	mockObserveReply,
	mockVoiceStore,
	mockSendMessage,
	mockStore,
	mockToast,
} = vi.hoisted(() => ({
	mockSubscribe: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribe: vi.fn().mockResolvedValue(undefined),
	mockChatId: vi.fn(() => "chat-abc123"),
	mockDetachPanel: vi.fn().mockResolvedValue(undefined),
	mockReattachPanel: vi.fn().mockResolvedValue(undefined),
	mockClosePanel: vi.fn().mockResolvedValue(undefined),
	mockReasoningChunks: vi.fn(() => ""),
	mockIsThinking: vi.fn(() => false),
	mockMessages: vi.fn(
		() =>
			[] as Array<{
				role: string;
				content: string;
				localId?: number;
				delivery?: string;
				failure?: string;
				turn?: { modelOverride?: string; reasoningEffort?: string };
			}>,
	),
	// Returns the unsubscribe function the hook stores for cleanup.
	mockObserveReply: vi.fn(() => vi.fn()),
	mockVoiceStore: {
		state: {
			config: { model: "q8f16", voice: "af_heart", speed: 1, barge_in: false, output_device: null },
			models: [],
			voices: [],
			outputDevices: [],
			engineState: "stopped",
			loadedModel: null,
			sessionActive: false,
			muted: false,
			agentState: "idle" as string,
			audioLevel: 0,
			downloading: null,
			downloadPercent: 0,
			loadingEngine: false,
			error: "",
		},
		startSession: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
		speak: vi.fn(),
		cancelSpeech: vi.fn(),
		setAgentState: vi.fn(),
		setMuted: vi.fn().mockResolvedValue(undefined),
		toggleMuted: vi.fn(),
	},
	mockSendMessage: vi.fn(),
	// The parts of the store the desktop message menu, the clear actions and the
	// failed-turn row drive. Each test sets what it needs.
	mockStore: {
		error: vi.fn(() => null as string | null),
		isStreaming: vi.fn(() => false),
		chatActivity: vi.fn(() => "idle"),
		chatActivityOf: vi.fn(() => "idle"),
		agentState: vi.fn(() => "idle"),
		agentError: vi.fn(() => null as string | null),
		agentGoal: vi.fn(() => null as { goal: string } | null),
		clearHistory: vi.fn(),
		setError: vi.fn(),
		retryMessage: vi.fn().mockResolvedValue(undefined),
		discardMessage: vi.fn(),
		retryAgent: vi.fn().mockResolvedValue(undefined),
		newConversation: vi.fn().mockResolvedValue("started"),
		clearView: vi.fn(() => true),
		forkConversation: vi.fn().mockResolvedValue("forked"),
	},
	mockToast: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	Channel: vi.fn(),
	convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("../../stores/toasts", () => ({ toastsStore: { add: mockToast } }));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(vi.fn()),
	emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../panelRouter", () => ({
	detachPanel: mockDetachPanel,
	reattachPanel: mockReattachPanel,
	closePanel: mockClosePanel,
}));

vi.mock("../../stores/conversationStore", () => ({
	isFailedDelivery: (message: { delivery?: string }) =>
		message.delivery === "not_sent" || message.delivery === "no_reply",
	conversationStore: {
		messages: mockMessages,
		visibleMessages: mockMessages,
		isStreaming: () => mockStore.isStreaming(),
		streamingText: () => "",
		error: () => mockStore.error(),
		chatId: mockChatId,
		sessionUsage: () => null,
		sendMessage: mockSendMessage,
		cancelStream: vi.fn(),
		clearHistory: mockStore.clearHistory,
		setError: mockStore.setError,
		chatActivity: () => mockStore.chatActivity(),
		chatActivityOf: () => mockStore.chatActivityOf(),
		agentError: () => mockStore.agentError(),
		agentGoal: () => mockStore.agentGoal(),
		retryMessage: mockStore.retryMessage,
		discardMessage: mockStore.discardMessage,
		retryAgent: mockStore.retryAgent,
		newConversation: mockStore.newConversation,
		clearView: mockStore.clearView,
		forkConversation: mockStore.forkConversation,
		subscribeToRegistry: mockSubscribe,
		unsubscribeFromRegistry: mockUnsubscribe,
		listAllConversations: vi.fn().mockResolvedValue([]),
		loadConversation: vi.fn(),
		resetChatId: vi.fn(),
		agentState: () => mockStore.agentState(),
		toolCalls: () => [],
		textChunks: () => null,
		unrestricted: () => false,
		setUnrestricted: vi.fn(),
		startAgent: vi.fn(),
		pauseAgent: vi.fn(),
		resumeAgent: vi.fn(),
		cancelAgent: vi.fn(),
		pendingApproval: () => null,
		approveAction: vi.fn(),
		currentIteration: () => 0,
		reset: vi.fn(),
		reasoningChunks: mockReasoningChunks,
		isThinking: mockIsThinking,
		observeReply: mockObserveReply,
	},
}));

// `activeId` is mutable so a test can reproduce a DETACHED window, where this
// store is never hydrated and therefore holds no active terminal at all.
const terminalsState = vi.hoisted(() => ({ activeId: "t1" as string | undefined, terminals: {} }));

vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		state: terminalsState,
		getIds: () => (terminalsState.activeId ? ["t1"] : []),
		get: () =>
			terminalsState.activeId
				? { sessionId: "sess-1", tuicSession: "sess-1", name: "Terminal 1", ref: null }
				: undefined,
	},
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../utils/sendCommand", () => ({
	sendCommand: vi.fn(),
	getShellFamily: vi.fn(() => "posix"),
}));

vi.mock("../../stores/ui", () => ({
	uiStore: {
		state: { detachedPanels: {} },
		isDetached: vi.fn(() => false),
		setDetached: vi.fn(),
		clearDetached: vi.fn(),
		setAiChatPanelMeasuredWidth: vi.fn(),
	},
}));

vi.mock("../../transport", () => ({
	isTauri: () => true,
	owningConnectionFor: () => undefined,
	rpc: vi.fn(async () => ({})),
}));

vi.mock("../../stores/voice", () => ({
	voiceStore: mockVoiceStore,
}));

vi.mock("../../components/ui/ContentRenderer", () => ({
	ContentRenderer: (props: { content: string }) => <div>{props.content}</div>,
}));

// Reactive store mock — `dictating()` reads state.recording, so a plain object
// would never re-render the composer when recording flips. The store must be
// built inside the (async) mock factory via a real import: a `require` here
// resolves a second copy of solid-js/store, whose proxies the component's
// reactive graph does not track.
// biome-ignore lint/suspicious/noExplicitAny: filled in by the mock factory below
const mockDictation = vi.hoisted(() => ({}) as any);

vi.mock("../../stores/dictation", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({
		recording: false,
		processing: false,
		rewriting: false,
		loading: false,
		audioLevel: 0,
		partialText: "",
		rewriteEnabled: false,
	});
	mockDictation.state = state;
	mockDictation.setState = setState;
	mockDictation.startRecording = vi.fn(async () => {
		setState("recording", true);
	});
	mockDictation.stopRecording = vi.fn(async () => {
		setState("recording", false);
		return { text: "hello from the mic", skip_reason: null, duration_s: 1 };
	});
	mockDictation.rewriteText = vi.fn(async () => "rewritten text");
	return { dictationStore: mockDictation };
});

import { AIChatPanel, historyDate } from "../../components/AIChatPanel/AIChatPanel";

describe("AIChatPanel lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue([]);
		mockReasoningChunks.mockReturnValue("");
		mockIsThinking.mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
	});

	// The Rust `ChatRegistry` has no producer — nothing calls `fan_out` or any
	// `ConversationState` setter — so `chat_subscribe` answered with an empty
	// default snapshot and then went silent. Applying that snapshot ran
	// `setMessages([])`, one IPC hop after `loadConversation` had filled them, so
	// opening a conversation from history blanked it. Subscribing again requires a
	// producer first.
	it("does not subscribe to the producerless chat registry", async () => {
		const { container, unmount } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		// Wait for the panel to be mounted and its effects flushed before asserting
		// a negative — otherwise the assertion passes before anything could run.
		await vi.waitFor(() => {
			expect(container.querySelector('button[title="Open in separate window"]')).not.toBeNull();
		});

		expect(mockSubscribe).not.toHaveBeenCalled();
		unmount();
		expect(mockUnsubscribe).not.toHaveBeenCalled();
	});

	it("renders detach button in main window mode", () => {
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const detachBtn = container.querySelector('button[title="Open in separate window"]');
		expect(detachBtn).not.toBeNull();
	});

	it("detach button calls detachPanel", () => {
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const detachBtn = container.querySelector('button[title="Open in separate window"]') as HTMLButtonElement;
		detachBtn.click();
		expect(mockDetachPanel).toHaveBeenCalledWith("ai-chat");
	});
});

describe("AIChatPanel extended-thinking disclosure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reasoning only streams after a user turn exists, so keep a user message present.
		mockMessages.mockReturnValue([{ role: "user", content: "hi" }]);
		mockReasoningChunks.mockReturnValue("");
		mockIsThinking.mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
	});

	it("does not render the disclosure when there is no reasoning", () => {
		mockReasoningChunks.mockReturnValue("");
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(container.querySelector("details")).toBeNull();
	});

	it("renders the Thinking disclosure when reasoning is present", async () => {
		mockReasoningChunks.mockReturnValue("planning the steps");
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.querySelector("summary")?.textContent).toBe("Thinking");
		await vi.waitFor(() => expect(details?.textContent).toContain("planning the steps"));
	});

	it("auto-opens the disclosure while the model is thinking", () => {
		mockReasoningChunks.mockReturnValue("still reasoning");
		mockIsThinking.mockReturnValue(true);
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
	});

	it("collapses the disclosure once thinking has finished", () => {
		mockReasoningChunks.mockReturnValue("done reasoning");
		mockIsThinking.mockReturnValue(false);
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
	});
});

describe("AIChatPanel dictation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue([]);
		mockDictation.setState({
			recording: false,
			processing: false,
			rewriting: false,
			loading: false,
			audioLevel: 0,
			partialText: "",
			rewriteEnabled: false,
		});
		// Restore the state-mutating implementations that clearAllMocks left in
		// place but whose per-test overrides may have replaced.
		mockDictation.startRecording.mockImplementation(async () => {
			mockDictation.setState("recording", true);
		});
		mockDictation.stopRecording.mockImplementation(async () => {
			mockDictation.setState("recording", false);
			return { text: "hello from the mic", skip_reason: null, duration_s: 1 };
		});
		mockDictation.rewriteText.mockResolvedValue("rewritten text");
	});

	afterEach(() => cleanup());

	it("shows a mic button and no live meter at rest", () => {
		const { getByTestId, queryByTestId } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(getByTestId("chat-mic-btn")).toBeTruthy();
		expect(queryByTestId("chat-mic-live")).toBeNull();
	});

	it("starts recording and reveals the level meter and stop button", async () => {
		const { getByTestId, findByTestId } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		getByTestId("chat-mic-btn").click();

		await vi.waitFor(() => expect(mockDictation.startRecording).toHaveBeenCalled());
		expect(await findByTestId("chat-mic-live")).toBeTruthy();
		expect(await findByTestId("chat-mic-stop-btn")).toBeTruthy();
	});

	it("inserts the transcript into the composer on stop", async () => {
		const { getByTestId, findByTestId, container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		getByTestId("chat-mic-btn").click();
		(await findByTestId("chat-mic-stop-btn")).click();

		await vi.waitFor(() => {
			const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textarea.value).toBe("hello from the mic");
		});
		// The transcript lands in the box for editing — it is never auto-sent.
		expect(mockDictation.rewriteText).not.toHaveBeenCalled();
	});

	it("applies the AI rewrite when it is enabled", async () => {
		mockDictation.setState("rewriteEnabled", true);
		const { getByTestId, findByTestId, container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		getByTestId("chat-mic-btn").click();
		(await findByTestId("chat-mic-stop-btn")).click();

		await vi.waitFor(() => {
			const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textarea.value).toBe("rewritten text");
		});
	});

	it("keeps the raw transcript when the rewrite fails", async () => {
		mockDictation.setState("rewriteEnabled", true);
		mockDictation.rewriteText.mockResolvedValueOnce(null);
		const { getByTestId, findByTestId, container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		getByTestId("chat-mic-btn").click();
		(await findByTestId("chat-mic-stop-btn")).click();

		await vi.waitFor(() => {
			const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
			expect(textarea.value).toBe("hello from the mic");
		});
	});

	it("surfaces a skip reason instead of inserting empty text", async () => {
		mockDictation.stopRecording.mockImplementationOnce(async () => {
			mockDictation.setState("recording", false);
			return { text: "", skip_reason: "too short", duration_s: 0.1 };
		});
		const { getByTestId, findByTestId, container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		getByTestId("chat-mic-btn").click();
		(await findByTestId("chat-mic-stop-btn")).click();

		expect((await findByTestId("chat-mic-error")).textContent).toContain("too short");
		expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
	});
});

describe("AIChatPanel voice mute", () => {
	beforeEach(() => {
		mockVoiceStore.state.muted = false;
		mockVoiceStore.state.agentState = "listening";
		mockVoiceStore.toggleMuted.mockClear();
		// The previous test's unmount stops its session; only calls made by this
		// one should count.
		mockVoiceStore.stopSession.mockClear();
	});

	/**
	 * Start a voice session the way the user does, and wait for its strip. The
	 * strip belongs to a detached chat window, the one place the conversation
	 * has no dock to be shown in.
	 */
	async function startVoice() {
		const view = render(() => (
			<AIChatPanel
				visible={true}
				onClose={() => {}}
				terminal={() => ({ sessionId: "sess-detached", name: "Terminal 7", attached: true })}
			/>
		));
		view.getByTestId("chat-voice-btn").click();
		await view.findByTestId("chat-voice-live");
		return view;
	}

	// Catches: the conversation drawn twice in the main window — once in the
	// dock under the terminal, once more in a strip inside this panel.
	it("leaves a running conversation to the dock when the panel is docked", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const button = view.getByTestId("chat-voice-btn");

		button.click();
		await vi.waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("true"));
		expect(view.queryByTestId("chat-voice-live")).toBeNull();

		// A docked panel does not end the conversation when it unmounts, so this
		// test hangs up itself.
		button.click();
		await vi.waitFor(() => expect(button.getAttribute("aria-pressed")).toBe("false"));
	});

	it("offers mute for the whole session, not only while the agent speaks", async () => {
		const view = await startVoice();
		expect(view.getByTestId("chat-voice-mute-btn")).toBeTruthy();
		// The interrupt button is the state-dependent one; mute must not come and
		// go with it, or it moves out from under the cursor mid-sentence.
		expect(view.queryByTestId("chat-voice-interrupt-btn")).toBeNull();
	});

	it("is absent until a session is running", () => {
		const view = render(() => (
			<AIChatPanel
				visible={true}
				onClose={() => {}}
				terminal={() => ({ sessionId: "sess-detached", name: "Terminal 7", attached: true })}
			/>
		));
		expect(view.queryByTestId("chat-voice-mute-btn")).toBeNull();
	});

	it("toggles the microphone without ending the session", async () => {
		const view = await startVoice();

		view.getByTestId("chat-voice-mute-btn").click();

		expect(mockVoiceStore.toggleMuted).toHaveBeenCalledOnce();
		expect(mockVoiceStore.stopSession).not.toHaveBeenCalled();
	});

	it("reads as unmute, and as pressed, once muted", async () => {
		mockVoiceStore.state.muted = true;
		mockVoiceStore.state.agentState = "muted";
		const view = await startVoice();

		const button = view.getByTestId("chat-voice-mute-btn");
		expect(button.textContent).toContain("Unmute");
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(view.getByTestId("chat-voice-live").textContent).toContain("Muted");
	});
});

// A detached panel window is a separate WebView: `terminalsStore` is never
// hydrated there (App returns at renderPanelMode before any main-window
// effect), so deriving the terminal from that store left the detached chat
// permanently read-only — it could show a conversation but never add to it.
// The window is therefore handed its terminal binding explicitly, and that
// binding is what every send, agent control and session lookup must use.
describe("AIChatPanel terminal binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue([]);
		terminalsState.activeId = "t1";
	});

	afterEach(() => {
		cleanup();
		terminalsState.activeId = "t1";
	});

	const typeAndSend = (container: HTMLElement, text: string) => {
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = text;
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return textarea;
	};

	it("sends with the handed-over session when the store has no terminals", () => {
		terminalsState.activeId = undefined; // the detached window
		const { container } = render(() => (
			<AIChatPanel
				visible={true}
				onClose={() => {}}
				terminal={() => ({ sessionId: "sess-detached", name: "Terminal 7", attached: true })}
			/>
		));

		const textarea = typeAndSend(container, "hello from the detached window");

		expect(textarea.disabled).toBe(false);
		expect(container.textContent).not.toContain("Focus a terminal to start");
		expect(mockSendMessage).toHaveBeenCalledWith("hello from the detached window", "sess-detached", expect.anything());
	});

	it("names the handed-over terminal in the header", () => {
		terminalsState.activeId = undefined;
		const { container } = render(() => (
			<AIChatPanel
				visible={true}
				onClose={() => {}}
				terminal={() => ({ sessionId: "sess-detached", name: "Terminal 7", attached: true })}
			/>
		));

		expect(container.textContent).toContain("Terminal 7");
	});

	// Detaching while no terminal is focused hands over nothing to send to. The
	// panel must stay read-only rather than send into a null session.
	it("stays read-only when the handed-over binding has no terminal", () => {
		terminalsState.activeId = undefined;
		const { container } = render(() => (
			<AIChatPanel
				visible={true}
				onClose={() => {}}
				terminal={() => ({ sessionId: null, name: null, attached: false })}
			/>
		));

		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.disabled).toBe(true);
		expect(container.textContent).toContain("Focus a terminal to start");
	});

	// The main window passes no binding and must keep deriving it from the
	// store exactly as before.
	it("falls back to the terminals store when no binding is handed over", () => {
		const { container } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);

		typeAndSend(container, "hello from the main window");

		expect(mockSendMessage).toHaveBeenCalledWith("hello from the main window", "sess-1", expect.anything());
	});
});

// ── Upstream 2.0.1–2.1.2 chat features, on FastAF's own desktop panel ────────
// The panel runs on FastAF's engine, so nothing here goes through ACP: these
// tests pin what the desktop offers and, as importantly, what it does not.
describe("AIChatPanel message menu", () => {
	const thread = [
		{ role: "user", content: "Why does it hang?", localId: 1 },
		{ role: "assistant", content: "Because of **this**.\nSecond line", localId: 2 },
	];

	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue(thread);
		mockStore.error.mockReturnValue(null);
		mockStore.isStreaming.mockReturnValue(false);
		mockStore.forkConversation.mockResolvedValue("forked");
		terminalsState.activeId = "t1";
	});

	afterEach(() => cleanup());

	const openMenu = (view: ReturnType<typeof render>, name: string) => {
		fireEvent.click(view.getByRole("button", { name }));
		return screen.getAllByRole("menuitem").map((item) => item.textContent);
	};

	// Catches: a permanent Copy button, or actions the engine cannot honour
	// (reactions and comments have nowhere to go on FastAF's engine).
	it("offers copy, raw Markdown, quote and fork on an answer, and nothing the engine cannot deliver", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.queryByRole("button", { name: /^Copy/ })).toBeNull();
		expect(openMenu(view, "Assistant message actions")).toEqual([
			"Copy message",
			"Show raw Markdown",
			"Quote reply",
			"Fork from here",
		]);
	});

	it("offers copy and quote on the user's own message", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(openMenu(view, "User message actions")).toEqual(["Copy message", "Quote reply"]);
	});

	// Catches: quote reply sending something, or the draft the user had being replaced.
	it("quotes a message into the composer under the draft, focused, and sends nothing", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: "About this:" } });
		openMenu(view, "Assistant message actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Quote reply" }));
		await vi.waitFor(() => expect(textarea.value).toBe("About this:\n\n> Because of **this**.\n> Second line\n\n"));
		await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it("shows the answer's Markdown source and goes back to the formatted answer", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		openMenu(view, "Assistant message actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Show raw Markdown" }));
		expect(view.getByLabelText("Raw Markdown").textContent).toBe("Because of **this**.\nSecond line");
		openMenu(view, "Assistant message actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Show formatted message" }));
		expect(view.queryByLabelText("Raw Markdown")).toBeNull();
	});

	// Catches: the fork cutting somewhere else than the answer it was asked on,
	// or reporting a fork that only went to History as if it were on screen.
	it.each([
		["forked", "Conversation forked", "info"],
		["saved", "Fork saved to History", "info"],
		["nothing", "Nothing to fork yet", "info"],
		["failed", "Fork failed", "error"],
	])("forks at the chosen answer and says what happened: %s", async (outcome, title, level) => {
		mockStore.forkConversation.mockResolvedValue(outcome);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		openMenu(view, "Assistant message actions");
		fireEvent.click(screen.getByRole("menuitem", { name: "Fork from here" }));
		expect(mockStore.forkConversation).toHaveBeenCalledWith(2);
		await vi.waitFor(() => expect(mockToast).toHaveBeenCalledWith(title, expect.any(String), level));
	});

	// Catches: quoting offered when there is no composer to quote into.
	it("offers no quote while no terminal is focused", () => {
		terminalsState.activeId = undefined;
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(openMenu(view, "Assistant message actions")).not.toContain("Quote reply");
	});
});

describe("AIChatPanel thread rows", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStore.error.mockReturnValue(null);
		mockStore.isStreaming.mockReturnValue(false);
		mockStore.agentState.mockReturnValue("idle");
		mockStore.agentGoal.mockReturnValue(null);
		terminalsState.activeId = "t1";
	});

	afterEach(() => cleanup());

	// Catches: the path marker shown as text, or the image drawn inside the tinted bubble.
	it("draws a path-based image above the message, outside its bubble", () => {
		mockMessages.mockReturnValue([{ role: "user", content: "[image: /tmp/run.png]\nSee this run.", localId: 1 }]);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const image = view.getByAltText("Attached image") as HTMLImageElement;
		expect(image.getAttribute("src")).toBe("asset:///tmp/run.png");
		const bubble = view.getByText("See this run.");
		expect(bubble.textContent).toBe("See this run.");
		expect(bubble.contains(image)).toBe(false);
		expect(view.container.querySelector('[data-prompt-images="single"]')).not.toBeNull();
	});

	// Catches: a long notice filling the thread, or its rest being unreachable.
	it("shows the first line of a long notice and keeps the rest one click away", () => {
		mockMessages.mockReturnValue([
			{
				role: "system",
				content: "Earlier turns were summarised.\nKept: the test name.\nDropped: the logs.",
				localId: 1,
			},
		]);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const details = view.container.querySelector('[role="note"] details') as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(details.querySelector("summary")?.textContent).toBe("Earlier turns were summarised.");
		expect(details.textContent).toContain("Dropped: the logs.");
	});

	it("draws a one-line notice as plain text, with nothing to open", () => {
		mockMessages.mockReturnValue([{ role: "system", content: "Context was trimmed.", localId: 1 }]);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.container.querySelector('[role="note"] details')).toBeNull();
		expect(view.container.querySelector('[role="note"]')?.textContent).toBe("Context was trimmed.");
	});

	it("marks a submitted message as Sending until the backend takes it", () => {
		mockMessages.mockReturnValue([{ role: "user", content: "On its way", localId: 4, delivery: "sending" }]);
		mockStore.isStreaming.mockReturnValue(true);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.getByRole("status").textContent).toBe("Sending…");
	});

	// Catches: the payload lost on a failed send, Retry re-typing it through the
	// composer (which would clobber a newer draft), or the reason shown twice.
	it("keeps a failed message with its reason, and retries it without touching the draft", () => {
		mockMessages.mockReturnValue([
			{ role: "user", content: "Add a test", localId: 7, delivery: "not_sent", failure: "Conversation already active" },
		]);
		mockStore.error.mockReturnValue("Conversation already active");
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: "a newer draft" } });

		const failed = view.getByRole("alert");
		expect(failed.textContent).toContain("Not sent");
		expect(failed.textContent).toContain("Conversation already active");
		expect(view.container.textContent?.split("Conversation already active")).toHaveLength(2);

		fireEvent.click(view.getByRole("button", { name: "Retry" }));
		expect(mockStore.retryMessage).toHaveBeenCalledWith(7, "sess-1");
		expect(mockSendMessage).not.toHaveBeenCalled();
		expect(textarea.value).toBe("a newer draft");

		fireEvent.click(view.getByRole("button", { name: "Discard" }));
		expect(mockStore.discardMessage).toHaveBeenCalledWith(7);
	});

	it("says No reply when the turn started and then failed", () => {
		mockMessages.mockReturnValue([
			{ role: "user", content: "Add a test", localId: 7, delivery: "no_reply", failure: "HTTP 401\nbad key" },
		]);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const failed = view.getByRole("alert");
		expect(failed.textContent).toContain("No reply");
		expect(failed.querySelector("summary")?.textContent).toBe("HTTP 401");
	});

	// Catches: Retry on the error row sending the question twice into the thread
	// for a turn that already owns a Retry, or dropping the model it was asked with.
	it("asks a cut-short reply again with the options it was asked with", () => {
		mockMessages.mockReturnValue([
			{ role: "user", content: "Explain", localId: 1, turn: { modelOverride: "m-1", reasoningEffort: "high" } },
			{ role: "assistant", content: "Half an answer", localId: 2 },
		]);
		mockStore.error.mockReturnValue("The reply stopped early: the turn ran out of time.");
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.container.textContent).toContain("The reply stopped early");
		fireEvent.click(view.getByRole("button", { name: "Retry" }));
		expect(mockSendMessage).toHaveBeenCalledWith("Explain", "sess-1", {
			modelOverride: "m-1",
			reasoningEffort: "high",
		});
	});

	it("offers to run a failed agent task again and wraps its error instead of cutting it", () => {
		mockMessages.mockReturnValue([{ role: "user", content: "hi", localId: 1 }]);
		mockStore.agentState.mockReturnValue("error");
		mockStore.agentError.mockReturnValue("HTTP 529\noverloaded");
		mockStore.agentGoal.mockReturnValue({ goal: "Bump the floor" });
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.container.textContent).toContain("Agent error: HTTP 529");
		fireEvent.click(view.getByRole("button", { name: "Run the task again" }));
		expect(mockStore.retryAgent).toHaveBeenCalledWith("sess-1");
	});

	it.each([
		["working", "Working"],
		["waiting", "Waiting for you"],
		["idle", "Idle"],
	])("names the chat's state on the header dot: %s", (state, label) => {
		mockMessages.mockReturnValue([]);
		mockStore.chatActivity.mockReturnValue(state);
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		expect(view.getByRole("img", { name: label })).toBeTruthy();
	});
});

describe("AIChatPanel clear, new conversation and fork commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue([
			{ role: "user", content: "q", localId: 1 },
			{ role: "assistant", content: "a", localId: 2 },
		]);
		mockStore.error.mockReturnValue(null);
		mockStore.isStreaming.mockReturnValue(false);
		mockStore.newConversation.mockResolvedValue("started");
		mockStore.forkConversation.mockResolvedValue("forked");
		mockStore.clearView.mockReturnValue(true);
		terminalsState.activeId = "t1";
	});

	afterEach(() => cleanup());

	const type = (container: HTMLElement, text: string) => {
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: text } });
		return textarea;
	};
	const enter = (textarea: HTMLTextAreaElement) => fireEvent.keyDown(textarea, { key: "Enter" });

	// Catches: /clear sent to the model as a message, deleting history, or passing silently.
	it("/clear starts a new conversation, keeps the old one and says so", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const textarea = type(view.container, "/clear");
		fireEvent.keyDown(textarea, { key: "Escape" }); // the list is closed: the typed command still runs
		enter(textarea);
		await vi.waitFor(() => expect(mockStore.newConversation).toHaveBeenCalledOnce());
		expect(mockSendMessage).not.toHaveBeenCalled();
		expect(mockStore.clearHistory).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith("New conversation", "The previous one is saved in History.", "info"),
		);
		await vi.waitFor(() => expect(textarea.value).toBe(""));
	});

	it("/new is the same command under its other name", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		enter(type(view.container, "/new"));
		await vi.waitFor(() => expect(mockStore.newConversation).toHaveBeenCalledOnce());
	});

	// Catches: a refused reset eating what was typed.
	it("keeps the draft when a running turn refuses /clear", async () => {
		mockStore.newConversation.mockResolvedValue("busy");
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const textarea = type(view.container, "/clear");
		enter(textarea);
		await vi.waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith("A reply is still running", expect.any(String), "info"),
		);
		expect(textarea.value).toBe("/clear");
	});

	it("/fork branches at the last completed answer", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		enter(type(view.container, "/fork"));
		await vi.waitFor(() => expect(mockStore.forkConversation).toHaveBeenCalledWith(undefined));
		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it("lists the commands for a lone slash and runs the highlighted one", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const textarea = type(view.container, "/");
		const commands = () => within(view.getByRole("listbox", { name: "Commands" })).getAllByRole("option");
		expect(commands().map((option) => option.textContent)).toEqual([
			"/clearStart a new conversation",
			"/forkBranch from the last answer",
		]);
		expect(commands()[0].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(textarea, { key: "ArrowDown" });
		expect(commands()[1].getAttribute("aria-selected")).toBe("true");
		enter(textarea);
		await vi.waitFor(() => expect(mockStore.forkConversation).toHaveBeenCalledOnce());
		expect(mockStore.newConversation).not.toHaveBeenCalled();
	});

	// Catches: a path or a sentence that starts with a slash being swallowed as a command.
	it.each(["/usr/local/bin is on my PATH?", "/etc/hosts", "/clear the cache and rebuild"])(
		"sends %s as an ordinary message",
		(text) => {
			const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
			const textarea = type(view.container, text);
			expect(view.queryByRole("listbox", { name: "Commands" })).toBeNull();
			enter(textarea);
			expect(mockSendMessage).toHaveBeenCalledWith(text, "sess-1", expect.anything());
			expect(mockStore.newConversation).not.toHaveBeenCalled();
		},
	);

	// Catches: the shortcut deleting or resetting anything, or acting on a hidden panel.
	it("clears the view on the routed shortcut and says nothing was deleted", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		window.dispatchEvent(new CustomEvent("fastaf:ai-chat-clear-view"));
		expect(mockStore.clearView).toHaveBeenCalledOnce();
		expect(mockStore.clearHistory).not.toHaveBeenCalled();
		expect(mockStore.newConversation).not.toHaveBeenCalled();
		expect(mockToast).toHaveBeenCalledWith(
			"Conversation view cleared",
			expect.stringContaining("Nothing was deleted"),
			"info",
		);
		view.unmount();
		window.dispatchEvent(new CustomEvent("fastaf:ai-chat-clear-view"));
		expect(mockStore.clearView).toHaveBeenCalledOnce();
	});

	it("ignores the routed shortcut while the panel is hidden", () => {
		render(() => <AIChatPanel visible={false} onClose={() => {}} />);
		window.dispatchEvent(new CustomEvent("fastaf:ai-chat-clear-view"));
		expect(mockStore.clearView).not.toHaveBeenCalled();
	});

	it("says so when there is nothing on screen to clear", () => {
		mockStore.clearView.mockReturnValue(false);
		render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		window.dispatchEvent(new CustomEvent("fastaf:ai-chat-clear-view"));
		expect(mockToast).toHaveBeenCalledWith("Nothing to clear", expect.any(String), "info");
	});

	// The trash is the one action that deletes, so it is named for that and confirms it.
	it("deletes the conversation from the header and confirms the deletion", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		fireEvent.click(view.getByRole("button", { name: "Delete conversation" }));
		expect(mockStore.clearHistory).toHaveBeenCalledOnce();
		expect(mockToast).toHaveBeenCalledWith("Conversation deleted", "It was removed from History.", "info");
	});
});

// Upstream 2.0.1: a click on the transcript or its controls left the focus on
// <body>, and the next key went to the terminal beside the chat.
describe("AIChatPanel keeps the keyboard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMessages.mockReturnValue([
			{ role: "user", content: "q", localId: 1 },
			{ role: "assistant", content: "the answer", localId: 2 },
		]);
		mockStore.error.mockReturnValue(null);
		terminalsState.activeId = "t1";
		window.getSelection()?.removeAllRanges();
	});

	afterEach(() => cleanup());

	it("marks the whole panel as the chat's focus target, so typing is never redirected from inside it", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const panel = view.container.querySelector("#ai-chat-panel") as HTMLElement;
		expect(panel.getAttribute("data-focus-target")).toBe("ai-chat");
		expect(view.getByRole("button", { name: "Conversation history" }).closest('[data-focus-target="ai-chat"]')).toBe(
			panel,
		);
	});

	it("moves the focus to the composer after a click on the thread", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const answer = await view.findByText("the answer");
		fireEvent.click(answer);
		expect(document.activeElement).toBe(view.container.querySelector("textarea"));
	});

	it("leaves the focus on a control that was clicked", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const history = view.getByRole("button", { name: "Conversation history" });
		fireEvent.click(history);
		expect(document.activeElement).toBe(history);
	});

	it("does not steal a text selection", async () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		const answer = await view.findByText("the answer");
		const range = document.createRange();
		range.selectNodeContents(answer);
		window.getSelection()?.addRange(range);
		fireEvent.click(answer);
		expect(document.activeElement).not.toBe(view.container.querySelector("textarea"));
		expect(window.getSelection()?.toString()).toBe("the answer");
	});

	it("hands a focus restored to the panel itself on to the composer", () => {
		const view = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		(view.container.querySelector("#ai-chat-panel") as HTMLElement).focus();
		expect(document.activeElement).toBe(view.container.querySelector("textarea"));
	});
});

describe("historyDate", () => {
	// Catches: the saved millisecond timestamp multiplied into the year 58000.
	it("reads a millisecond timestamp as this era, and still accepts seconds", () => {
		const ms = Date.UTC(2026, 10, 27, 12);
		expect(historyDate(ms)).toBe(new Date(ms).toLocaleDateString());
		expect(historyDate(ms / 1000)).toBe(new Date(ms).toLocaleDateString());
	});
});
