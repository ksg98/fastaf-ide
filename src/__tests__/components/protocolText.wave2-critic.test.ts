import { expect, it } from "vitest";
import { projectChatProtocolText } from "../../components/AIChatPanel/protocolText";

// Catches: the end-anchored title parser consumes a reply ending in parentheses as status text.
it("keeps a same-line reply ending in parentheses in the message body", () => {
	const projected = projectChatProtocolText("intent: Chatting (Chat)Hello there (welcome back)");
	expect(projected.intent).toEqual({ text: "Chatting", title: "Chat" });
	expect(projected.body).toBe("Hello there (welcome back)");
});

// Catches: the first parenthesized description is mistaken for the title when a reply follows.
it("keeps description parentheses separate from the title and same-line reply", () => {
	const projected = projectChatProtocolText("intent: Reviewing code (Rust) (Review)Found a missing check.");
	expect(projected.intent).toEqual({ text: "Reviewing code (Rust)", title: "Review" });
	expect(projected.body).toBe("Found a missing check.");
});
