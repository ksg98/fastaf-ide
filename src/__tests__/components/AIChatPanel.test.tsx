import { cleanup, render } from "@solidjs/testing-library";
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
} = vi.hoisted(() => ({
	mockSubscribe: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribe: vi.fn().mockResolvedValue(undefined),
	mockChatId: vi.fn(() => "chat-abc123"),
	mockDetachPanel: vi.fn().mockResolvedValue(undefined),
	mockReattachPanel: vi.fn().mockResolvedValue(undefined),
	mockClosePanel: vi.fn().mockResolvedValue(undefined),
	mockReasoningChunks: vi.fn(() => ""),
	mockIsThinking: vi.fn(() => false),
	mockMessages: vi.fn(() => [] as Array<{ role: string; content: string }>),
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
			agentState: "idle" as const,
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
	},
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	Channel: vi.fn(),
}));

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
	conversationStore: {
		messages: mockMessages,
		isStreaming: () => false,
		streamingText: () => "",
		error: () => null,
		chatId: mockChatId,
		sessionUsage: () => null,
		sendMessage: vi.fn(),
		cancelStream: vi.fn(),
		clearHistory: vi.fn(),
		subscribeToRegistry: mockSubscribe,
		unsubscribeFromRegistry: mockUnsubscribe,
		listAllConversations: vi.fn().mockResolvedValue([]),
		loadConversation: vi.fn(),
		resetChatId: vi.fn(),
		agentState: () => "idle",
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

vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		state: { activeId: "t1", terminals: {} },
		getIds: () => ["t1"],
		get: () => ({ sessionId: "sess-1", tuicSession: "sess-1", name: "Terminal 1", ref: null }),
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
	},
}));

vi.mock("../../transport", () => ({
	isTauri: () => true,
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

import { AIChatPanel } from "../../components/AIChatPanel/AIChatPanel";

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

	it("subscribes to registry on mount with current chatId", async () => {
		render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		await vi.waitFor(() => {
			expect(mockSubscribe).toHaveBeenCalledWith("chat-abc123");
		});
	});

	it("unsubscribes from registry on unmount", async () => {
		const { unmount } = render(() => <AIChatPanel visible={true} onClose={() => {}} />);
		await vi.waitFor(() => {
			expect(mockSubscribe).toHaveBeenCalled();
		});
		unmount();
		expect(mockUnsubscribe).toHaveBeenCalled();
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
