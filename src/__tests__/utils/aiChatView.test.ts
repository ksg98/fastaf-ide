import { afterEach, describe, expect, it, vi } from "vitest";
import { aiChatHasFocus, CLEAR_CHAT_VIEW_EVENT, routeClearToAiChat } from "../../utils/aiChatView";

describe("aiChatView", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	const mountChat = () => {
		const panel = document.createElement("div");
		panel.setAttribute("data-focus-target", "ai-chat");
		const button = document.createElement("button");
		const composer = document.createElement("textarea");
		panel.append(button, composer);
		document.body.append(panel);
		return { button, composer };
	};

	// Catches: the shortcut reaching the chat while the user is typing somewhere else.
	it("leaves a clear alone when the keyboard is not in AI Chat", () => {
		mountChat();
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();
		const cleared = vi.fn();
		window.addEventListener(CLEAR_CHAT_VIEW_EVENT, cleared);

		expect(aiChatHasFocus()).toBe(false);
		expect(routeClearToAiChat()).toBe(false);

		window.removeEventListener(CLEAR_CHAT_VIEW_EVENT, cleared);
		expect(cleared).not.toHaveBeenCalled();
	});

	// The focus can sit on any control of the panel, not only on the composer.
	it.each(["composer", "button"] as const)("takes a clear while the %s holds the focus", (target) => {
		const chat = mountChat();
		chat[target].focus();
		const cleared = vi.fn();
		window.addEventListener(CLEAR_CHAT_VIEW_EVENT, cleared);

		expect(routeClearToAiChat()).toBe(true);

		window.removeEventListener(CLEAR_CHAT_VIEW_EVENT, cleared);
		expect(cleared).toHaveBeenCalledOnce();
	});
});
