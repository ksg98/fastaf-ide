import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeDockBridge } from "../../components/ComposeDock/dockBridge";
import { captureDictationTarget } from "../../hooks/dictationTarget";
import { terminalsStore } from "../../stores/terminals";

describe("dictation target in terminal Chat with the compose dock", () => {
	let unregister: (() => void) | undefined;
	let field: HTMLTextAreaElement;

	function chatTerminal(): string {
		const id = terminalsStore.add({
			sessionId: "s-chat",
			fontSize: 14,
			name: "claude",
			cwd: null,
			awaitingInput: null,
		});
		terminalsStore.setActive(id);
		terminalsStore.setViewMode(id, "chat");
		const root = document.createElement("div");
		root.dataset.terminalId = id;
		const transcript = document.createElement("div");
		transcript.tabIndex = 0;
		root.append(transcript);
		document.body.append(root);
		transcript.focus();
		return id;
	}

	beforeEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		document.body.innerHTML = "";
		field = document.createElement("textarea");
		document.body.append(field);
	});
	afterEach(() => unregister?.());

	// Catches: the dictation hotkey doing nothing in Chat, which has no composer of
	// its own while the dock is on screen.
	it("opens the dock and targets its field when the conversation has focus", async () => {
		unregister = composeDockBridge.register({
			open: () => {
				field.focus();
				return true;
			},
		});
		chatTerminal();
		const target = captureDictationTarget();
		expect(target.kind).toBe("input");
		await target.deliver("hello", async () => {}, false);
		expect(field.value).toContain("hello");
	});

	// Catches: a capture that loops or throws when there is no dock to open.
	it("stays a compose target that reports unavailable when no dock is mounted", () => {
		chatTerminal();
		expect(captureDictationTarget().kind).toBe("compose");
	});
});
