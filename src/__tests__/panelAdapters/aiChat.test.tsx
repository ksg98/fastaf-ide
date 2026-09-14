import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A detached AI Chat window is a fresh WebView: its conversation store starts
// empty and generates its own chat id. The only thing tying it back to the
// conversation it was detached from is the `chatId` query param, so the mount
// path MUST both adopt that id and read the conversation off disk. Setting the
// id without loading leaves the window blank; loading without setting the id
// first leaves it writing into an id nobody else opens, because
// `loadConversation` takes the id from the file it manages to read and a brand
// new conversation has no file yet.

const h = vi.hoisted(() => ({
	setChatId: vi.fn(),
	setActiveTerminal: vi.fn(),
	invalidateTerminal: vi.fn(),
	loadConversation: vi.fn(),
	chatId: vi.fn(() => "current-chat"),
	initPanelWindow: vi.fn(),
	calls: [] as string[],
	terminal: { activeId: "t1" as string | undefined },
}));

vi.mock("../../stores/conversationStore", () => ({
	conversationStore: {
		setChatId: (id: string) => {
			h.calls.push("setChatId");
			return h.setChatId(id);
		},
		setActiveTerminal: (key: string) => {
			h.calls.push("setActiveTerminal");
			return h.setActiveTerminal(key);
		},
		invalidateTerminal: (key: string) => h.invalidateTerminal(key),
		loadConversation: (id: string) => {
			h.calls.push("loadConversation");
			return h.loadConversation(id);
		},
		chatId: () => h.chatId(),
	},
}));

vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		state: h.terminal,
		get: (id: string) =>
			id
				? { sessionId: `sess-${id.slice(1)}`, tuicSession: `tuic-${id.slice(1)}`, name: `Terminal ${id.slice(1)}` }
				: undefined,
	},
}));

vi.mock("../../hooks/initPanelWindow", () => ({ initPanelWindow: h.initPanelWindow }));

// Render the binding the adapter hands down, so a test can assert on what the
// detached window will actually send with.
vi.mock("../../components/AIChatPanel/AIChatPanel", () => ({
	AIChatPanel: (props: { terminal?: () => { sessionId: string | null; name: string | null; attached: boolean } }) => (
		<div
			data-testid="ai-chat-panel"
			data-session={props.terminal?.().sessionId ?? ""}
			data-name={props.terminal?.().name ?? ""}
			data-attached={String(props.terminal?.().attached ?? false)}
		/>
	),
}));

import { aiChatPanelAdapter } from "../../panelAdapters/aiChat";

/** Let the mount's async work settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("detached AI Chat panel adapter", () => {
	beforeEach(() => {
		h.setChatId.mockReset();
		h.setActiveTerminal.mockReset();
		h.invalidateTerminal.mockReset();
		h.loadConversation.mockReset();
		h.loadConversation.mockResolvedValue(undefined);
		h.initPanelWindow.mockReset();
		h.initPanelWindow.mockResolvedValue(undefined);
		h.calls.length = 0;
		h.terminal.activeId = "t1";
	});

	it("adopts the chat id and loads that conversation from disk on mount", async () => {
		const { getByTestId } = render(() => (
			<aiChatPanelAdapter.Component params={new URLSearchParams("chatId=conv-42")} />
		));
		await settle();

		expect(getByTestId("ai-chat-panel")).toBeTruthy();
		expect(h.setChatId).toHaveBeenCalledWith("conv-42");
		expect(h.loadConversation).toHaveBeenCalledWith("conv-42");
		// Order matters: the id is authoritative, the disk read is best effort.
		expect(h.calls).toEqual(["setChatId", "loadConversation"]);
	});

	it("opens empty without an error when the id has nothing saved under it", async () => {
		// `loadConversation` already swallows a missing conversation, so the
		// adapter must not add a rejection of its own on top of it.
		h.loadConversation.mockResolvedValue(undefined);

		const { getByTestId } = render(() => (
			<aiChatPanelAdapter.Component params={new URLSearchParams("chatId=never-saved")} />
		));
		await settle();

		expect(getByTestId("ai-chat-panel")).toBeTruthy();
		expect(h.setChatId).toHaveBeenCalledWith("never-saved");
		expect(h.loadConversation).toHaveBeenCalledWith("never-saved");
	});

	it("leaves the store alone when no chat id was passed", async () => {
		render(() => <aiChatPanelAdapter.Component params={new URLSearchParams()} />);
		await settle();

		expect(h.setChatId).not.toHaveBeenCalled();
		expect(h.loadConversation).not.toHaveBeenCalled();
	});

	it("detaches with the same param keys the mount path reads back", () => {
		// The keys the window is opened with and the keys the window reads have
		// to match, or the load silently never happens.
		expect(aiChatPanelAdapter.id).toBe("ai-chat");
		expect(aiChatPanelAdapter.detachParams?.()).toEqual({
			chatId: "current-chat",
			terminalKey: "tuic-1",
			sessionId: "sess-1",
			terminalName: "Terminal 1",
		});
	});

	// Detaching with no terminal focused has no session to hand over. Empty
	// strings, not the words "null"/"undefined", which URLSearchParams would
	// hand back as a perfectly valid session id.
	it("hands over empty terminal params when no terminal is focused", () => {
		h.terminal.activeId = undefined;

		expect(aiChatPanelAdapter.detachParams?.()).toEqual({
			chatId: "current-chat",
			terminalKey: "",
			sessionId: "",
			terminalName: "",
		});
	});

	// conversationStore keys its state per terminal. Adopting the terminal AFTER
	// the chat id would swap in a fresh empty state and drop the id, and every
	// later save would go out under the default key — which persists
	// `session_id: null` and orphans the conversation from its terminal.
	it("adopts the terminal before the chat id", async () => {
		render(() => (
			<aiChatPanelAdapter.Component
				params={new URLSearchParams("chatId=conv-42&terminalKey=tuic-1&sessionId=sess-1&terminalName=Term")}
			/>
		));
		await settle();

		expect(h.setActiveTerminal).toHaveBeenCalledWith("tuic-1");
		expect(h.calls).toEqual(["setActiveTerminal", "setChatId", "loadConversation"]);
	});

	// Without a binding the detached chat is read-only: terminalsStore is never
	// hydrated in a panel window, so the panel cannot find a session on its own.
	it("hands the panel the terminal binding it was opened with", async () => {
		const { getByTestId } = render(() => (
			<aiChatPanelAdapter.Component
				params={new URLSearchParams("chatId=conv-42&terminalKey=tuic-1&sessionId=sess-9&terminalName=Term%207")}
			/>
		));
		await settle();

		const panel = getByTestId("ai-chat-panel");
		expect(panel.getAttribute("data-session")).toBe("sess-9");
		expect(panel.getAttribute("data-name")).toBe("Term 7");
		expect(panel.getAttribute("data-attached")).toBe("true");
	});

	it("hands the panel an unattached binding when it was detached with no terminal", async () => {
		const { getByTestId } = render(() => (
			<aiChatPanelAdapter.Component
				params={new URLSearchParams("chatId=conv-42&terminalKey=&sessionId=&terminalName=")}
			/>
		));
		await settle();

		const panel = getByTestId("ai-chat-panel");
		expect(panel.getAttribute("data-session")).toBe("");
		expect(panel.getAttribute("data-attached")).toBe("false");
		expect(h.setActiveTerminal).not.toHaveBeenCalled();
	});

	// Criterion: messages sent from the detached window must be there when the
	// panel is reopened in the main window. The main window's store is frozen
	// at the instant it detached — only the detached copy persisted anything —
	// so coming home has to re-read the conversation off disk.
	it("re-reads the conversation when the panel comes back to the main window", () => {
		aiChatPanelAdapter.detachParams?.();

		aiChatPanelAdapter.onReattach?.();

		expect(h.loadConversation).toHaveBeenCalledWith("current-chat");
	});

	// Switching terminals in the main window while the chat is detached moves
	// `chatId()` onto the OTHER terminal's conversation. Re-reading that one
	// would leave the detached terminal's cached state stale forever, because
	// `initFromDisk` skips a state it has already initialized — so the user
	// would switch back and see the conversation as it was before detaching.
	it("invalidates the detached terminal instead when the main window moved on", () => {
		aiChatPanelAdapter.detachParams?.(); // detached while "tuic-1" was active
		h.terminal.activeId = "t2";

		aiChatPanelAdapter.onReattach?.();

		expect(h.invalidateTerminal).toHaveBeenCalledWith("tuic-1");
		expect(h.loadConversation).not.toHaveBeenCalled();
	});
});
