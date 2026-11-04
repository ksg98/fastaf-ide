import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The terminal's AI entries.
 *
 * FastAF's chat runs on its built-in engine and is bound to a terminal, so the
 * entries send the question straight to the right-clicked terminal's
 * conversation (upstream 2.0 drafts it into ego's composer instead).
 */

const terminals = vi.hoisted(() => ({
	state: { terminals: {} as Record<string, unknown> },
	getIds: () => Object.keys(terminals.state.terminals),
	get: (id: string) => terminals.state.terminals[id],
	setActive: vi.fn(),
}));

const ui = vi.hoisted(() => ({ setAiChatPanelVisible: vi.fn() }));
const conversation = vi.hoisted(() => ({ sendMessage: vi.fn(), setActiveTerminal: vi.fn() }));

vi.mock("../../stores/terminals", () => ({ terminalsStore: terminals }));
vi.mock("../../stores/conversationStore", () => ({ conversationStore: conversation }));
vi.mock("../../stores/ui", () => ({ uiStore: ui }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerAiChatContextActions, truncateText } from "../../components/AIChatPanel/contextMenuActions";
import { contextMenuActionsStore } from "../../stores/contextMenuActionsStore";

/** One terminal holding a selection and a buffer, as the store keeps it. */
function terminal(selection: string, lines: string[] = []) {
	return {
		sessionId: "sess-1",
		ref: {
			getSelection: () => selection,
			getBufferLines: async () => lines,
		},
	};
}

function action(id: string) {
	return contextMenuActionsStore.getContextActions("terminal").find((entry) => entry.id === id);
}

let registered: Array<{ dispose(): void }> = [];

beforeEach(() => {
	vi.clearAllMocks();
	registered.forEach((disposable) => disposable.dispose());
	terminals.state.terminals = { t1: terminal("") };
	registered = registerAiChatContextActions();
});

describe("truncateText", () => {
	it("leaves text that fits alone", () => {
		expect(truncateText("short", 10)).toBe("short");
	});

	it("says where it cut", () => {
		expect(truncateText("abcdef", 3)).toBe("abc\n[... truncated]");
	});
});

describe("the AI entries on a terminal", () => {
	it("registers both, under the ids they always had", () => {
		expect(contextMenuActionsStore.getContextActions("terminal").map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["ai-chat:explain", "ai-chat:fix-error"]),
		);
	});

	it("asks about the selection and opens the panel", async () => {
		terminals.state.terminals = { t1: terminal("error: no such file") };

		action("ai-chat:explain")?.action({ target: "terminal", sessionId: "sess-1" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(conversation.sendMessage).toHaveBeenCalledWith(expect.stringContaining("error: no such file"), "sess-1");
		expect(conversation.sendMessage).toHaveBeenCalledWith(
			expect.stringContaining("Explain this terminal output"),
			"sess-1",
		);
		expect(ui.setAiChatPanelVisible).toHaveBeenCalledWith(true);
		// The panel follows the terminal the question is about.
		expect(terminals.setActive).toHaveBeenCalledWith("t1");
	});

	// Nothing selected is the common case: a person right-clicks after watching
	// a command fail, and what they mean is what is on the screen.
	it("falls back to the tail of the screen when nothing is selected", async () => {
		terminals.state.terminals = { t1: terminal("", ["cargo build", "error[E0433]: failed to resolve"]) };

		action("ai-chat:fix-error")?.action({ target: "terminal", sessionId: "sess-1" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(conversation.sendMessage).toHaveBeenCalledWith(
			expect.stringContaining("error[E0433]: failed to resolve"),
			"sess-1",
		);
		expect(conversation.sendMessage).toHaveBeenCalledWith(expect.stringContaining("suggest a fix"), "sess-1");
	});

	// A terminal with nothing in it has nothing to ask about, and opening the
	// panel on an empty question would look like the entry misfired.
	it("writes nothing and opens nothing when there is no output", async () => {
		terminals.state.terminals = { t1: terminal("", []) };

		action("ai-chat:explain")?.action({ target: "terminal", sessionId: "sess-1" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(conversation.sendMessage).not.toHaveBeenCalled();
		expect(ui.setAiChatPanelVisible).not.toHaveBeenCalled();
	});
});
