import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

const ptyMocks = vi.hoisted(() => ({
	sendCommand: vi.fn().mockResolvedValue(undefined),
	enqueueCommand: vi.fn().mockResolvedValue({ queued: 2, id: 7 }),
}));

vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ sendCommand: ptyMocks.sendCommand, enqueueCommand: ptyMocks.enqueueCommand }),
}));

import { ComposeDock } from "../../components/ComposeDock/ComposeDock";
import { buildStartTargets, type StartTarget, startCommandFor } from "../../components/ComposeDock/composeTargets";
import { composeDockBridge } from "../../components/ComposeDock/dockBridge";
import { dockSendMode } from "../../components/ComposeDock/dockSend";
import { chatViewStore } from "../../stores/chatView";
import { dictationStore } from "../../stores/dictation";
import { repositoriesStore } from "../../stores/repositories";
import { talkStore } from "../../stores/talk";
import { terminalsStore } from "../../stores/terminals";
import { toastsStore } from "../../stores/toasts";
import { voiceSetup } from "../../stores/voiceSetup";
import { enableAiChat, voiceInstallAnswer } from "../helpers/voiceReady";

const REPO = "/repo/demo";

function addTerminal(name: string, agentType: "claude" | null, sessionId = `s-${name}`): string {
	const id = terminalsStore.add({ sessionId, cwd: REPO, name, awaitingInput: null, fontSize: 14 } as Parameters<
		typeof terminalsStore.add
	>[0]);
	if (agentType) terminalsStore.update(id, { agentType });
	return id;
}

function input(container: HTMLElement): HTMLTextAreaElement {
	const el = container.querySelector('[data-testid="compose-input"]');
	expect(el, "compose input").toBeTruthy();
	return el as HTMLTextAreaElement;
}

function type(field: HTMLTextAreaElement, value: string): void {
	fireEvent.input(field, { target: { value } });
}

beforeEach(async () => {
	ptyMocks.sendCommand.mockClear();
	ptyMocks.enqueueCommand.mockClear();
	// saveConfig reads the stored config first and refuses to write without one.
	mockInvoke
		.mockReset()
		.mockImplementation(async (cmd: string) => (cmd === "get_dictation_config" ? { enabled: false } : undefined));
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	repositoriesStore.setActive(null);
	// saveConfig updates the store only after the (mocked) backend call resolves.
	await dictationStore.saveConfig({ enabled: true });
});

afterEach(() => {
	cleanup();
	// repositoriesStore debounces its save; drop it so no timer outlives the test.
	repositoriesStore._testCancelPendingSave();
});

describe("composeTargets", () => {
	it("offers only agents that take a starting prompt — never a shell that would run the text", () => {
		const targets = buildStartTargets([
			{ type: "goose", name: "Goose", command: "goose" },
			{ type: "claude", name: "Claude Code", command: "claude --model opus" },
			{ type: "codex", name: "Codex CLI", command: "codex" },
		]);
		expect(targets.map((t) => t.id)).toEqual(["claude", "codex"]);
		expect(targets[0]!.command).toBe("claude --model opus");
	});

	it("passes the text to the agent as one quoted argument, so it is never run as a command", () => {
		const claude: StartTarget = { id: "claude", label: "Claude Code", agentType: "claude", command: "claude" };
		expect(startCommandFor(claude, "fix the user's bug")).toBe("claude 'fix the user'\\''s bug'");
		expect(startCommandFor(claude, "rm -rf build; echo done")).toBe("claude 'rm -rf build; echo done'");
	});

	it("puts a prompt that looks like a flag after --", () => {
		const codex: StartTarget = { id: "codex", label: "Codex CLI", agentType: "codex", command: "codex" };
		expect(startCommandFor(codex, "--help me")).toBe("codex -- '--help me'");
	});
});

describe("ComposeDock (dock)", () => {
	const renderDock = (onDictationStart = vi.fn()) =>
		render(() => <ComposeDock variant="dock" onDictationStart={onDictationStart} onDictationStop={vi.fn()} />);
	const bar = (container: HTMLElement) => container.querySelector('[data-testid="compose-bar"]');
	const click = (container: HTMLElement, testId: string) => {
		const el = container.querySelector(`[data-testid="${testId}"]`);
		expect(el, testId).toBeTruthy();
		fireEvent.click(el as HTMLButtonElement);
	};

	it("rests as one row — Dictate, Type, and which terminal they go to — with no second text box", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		expect(bar(container)).not.toBeNull();
		expect(container.querySelector('[data-testid="compose-input"]')).toBeNull();
		// "Speak" became "Dictate" when Talk arrived: the two words side by side
		// said the same thing about two different things.
		expect(container.querySelector('[data-testid="compose-speak"]')?.textContent).toBe("Dictate");
		// Talk is offered only where the app says a conversation can run.
		expect(container.querySelector('[data-testid="talk-start"]')).toBeNull();
		expect(container.querySelector('[data-testid="compose-type"]')?.textContent).toBe("Type");
		expect(container.querySelector('[data-testid="compose-target"]')?.textContent).toContain("Claude Code");
	});

	it("Type opens the card with the field focused and inviting speech", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		expect(document.activeElement).toBe(field);
		expect(field.placeholder).toBe("Speak or type a prompt");
		expect(bar(container)).toBeNull();
	});

	it("drops Speak and the mic, and stops inviting speech, when dictation is off", async () => {
		await dictationStore.saveConfig({ enabled: false });
		terminalsStore.setActive(addTerminal("zsh", null));
		const { container } = renderDock();
		expect(container.querySelector('[data-testid="compose-speak"]')).toBeNull();
		click(container, "compose-type");
		expect(input(container).placeholder).toBe("Type a prompt");
		expect(container.querySelector('[data-testid="compose-mic"]')).toBeNull();
	});

	it("Enter sends to the active terminal with its agent's Enter semantics, then folds back into the bar", async () => {
		const id = addTerminal("Claude Code", "claude", "session-a");
		terminalsStore.setActive(id);
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "run the tests");
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(ptyMocks.sendCommand).toHaveBeenCalledWith("session-a", "run the tests", "claude"));
		await waitFor(() => expect(bar(container)).not.toBeNull());
		expect(ptyMocks.enqueueCommand).not.toHaveBeenCalled();
	});

	it("Shift+Enter is a newline, not a send", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "line one");
		fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
		expect(input(container)).toBe(field);
	});

	it("Option+Enter queues for an agent, shows the count, and stays open for the next one", async () => {
		const id = addTerminal("Claude Code", "claude", "session-q");
		terminalsStore.setActive(id);
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "then push");
		fireEvent.keyDown(field, { key: "Enter", altKey: true });
		await waitFor(() => expect(ptyMocks.enqueueCommand).toHaveBeenCalledWith("session-q", "then push"));
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(container.querySelector('[data-testid="compose-queued"]')?.textContent).toBe("2 queued"),
		);
		await waitFor(() => expect(field.value).toBe(""));
		expect(bar(container)).toBeNull();
	});

	it("keeps an unsent draft per terminal across tab switches, reopening the card where one waits", async () => {
		const a = addTerminal("Claude Code", "claude");
		const b = addTerminal("zsh", null);
		terminalsStore.setActive(a);
		const { container } = renderDock();
		click(container, "compose-type");
		type(input(container), "half a thought");
		terminalsStore.setActive(b);
		await waitFor(() => expect(bar(container)).not.toBeNull());
		terminalsStore.setActive(a);
		await waitFor(() => expect(input(container).value).toBe("half a thought"));
	});

	it("Dictate opens the card and focuses the field before dictation starts, so the transcript lands here", async () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const seen: { focusedAtStart: Element | null } = { focusedAtStart: null };
		const onStart = vi.fn(() => {
			seen.focusedAtStart = document.activeElement;
		});
		const { container } = renderDock(onStart);
		click(container, "compose-speak");
		await waitFor(() => expect(onStart).toHaveBeenCalled());
		expect(seen.focusedAtStart?.getAttribute("data-testid")).toBe("compose-input");
		// Nothing started recording (the mock does not), so the empty card folds back.
		await waitFor(() => expect(bar(container)).not.toBeNull());
	});

	it("Escape hands an empty card back to the bar", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		fireEvent.keyDown(input(container), { key: "Escape" });
		expect(bar(container)).not.toBeNull();
	});

	it("is disabled when the active terminal has no session yet", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude", ""));
		terminalsStore.update(terminalsStore.state.activeId!, { sessionId: null });
		const { container } = renderDock();
		expect((container.querySelector('[data-testid="compose-speak"]') as HTMLButtonElement).disabled).toBe(true);
		expect((container.querySelector('[data-testid="compose-type"]') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("ComposeDock talk mode", () => {
	const calls = (cmd: string) => mockInvoke.mock.calls.filter(([name]) => name === cmd).length;
	const q = (container: HTMLElement, testId: string) =>
		container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
	const renderTalkDock = (props: { onDictationStart?: () => void; onOpenTranscript?: () => void } = {}) =>
		render(() => (
			<ComposeDock
				variant="dock"
				talk
				onDictationStart={props.onDictationStart ?? vi.fn()}
				onDictationStop={vi.fn()}
				onOpenTranscript={props.onOpenTranscript}
			/>
		));
	let disableAiChat: () => void;

	beforeEach(() => {
		// An install where voice is set up; one test below takes that away.
		mockInvoke.mockImplementation(async (cmd: string) => voiceInstallAnswer(cmd));
		disableAiChat = enableAiChat();
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
	});

	afterEach(async () => {
		// The conversation belongs to the window, not to the dock that was
		// unmounted, so each test hangs up what it started.
		await talkStore.stop();
		voiceSetup.dismiss();
		disableAiChat();
	});

	it("puts the Talk orb in the row, between what you type and where it goes", () => {
		const { container } = renderTalkDock();
		const row = [...(container.querySelector('[data-testid="compose-bar"]') as HTMLElement).children];
		const position = (testId: string) =>
			row.findIndex(
				(zone) => zone.matches(`[data-testid="${testId}"]`) || !!zone.querySelector(`[data-testid="${testId}"]`),
			);

		expect(q(container, "talk-start")?.textContent).toContain("Talk");
		expect(position("compose-type")).toBe(0);
		expect(position("talk-start")).toBe(1);
		expect(position("compose-target")).toBe(2);
	});

	it("starts the conversation from the orb and gives the row over to it", async () => {
		const { container } = renderTalkDock();

		fireEvent.click(q(container, "talk-start") as HTMLElement);

		await waitFor(() => expect(q(container, "talk-stage")).not.toBeNull());
		expect(calls("voice_start")).toBe(1);
		expect(container.querySelector('[data-testid="compose-bar"]')).toBeNull();
		await waitFor(() => expect(talkStore.active()).toBe(true));
	});

	it("ends the conversation from the stage and gives the row back", async () => {
		const { container } = renderTalkDock();
		fireEvent.click(q(container, "talk-start") as HTMLElement);
		await waitFor(() => expect(talkStore.active()).toBe(true));

		fireEvent.click(q(container, "talk-end") as HTMLElement);

		await waitFor(() => expect(container.querySelector('[data-testid="compose-bar"]')).not.toBeNull());
		expect(calls("voice_stop")).toBe(1);
		expect(q(container, "talk-stage")).toBeNull();
	});

	// Catches: typing made impossible for as long as a conversation runs.
	it("still lets you type to the terminal while talking, with the stage staying put", async () => {
		const { container } = renderTalkDock();
		fireEvent.click(q(container, "talk-start") as HTMLElement);
		await waitFor(() => expect(talkStore.active()).toBe(true));

		fireEvent.click(q(container, "compose-type") as HTMLElement);

		expect(container.querySelector('[data-testid="compose-input"]')).not.toBeNull();
		expect(q(container, "talk-stage")).not.toBeNull();
		// The card is open, so the stage no longer needs its own Type button.
		expect(q(container, "compose-type")).toBeNull();
	});

	// Catches: dictation asked to start under a running conversation. The
	// microphone has one owner; Rust refuses, and the card would sit open
	// "listening" for a transcript that never comes.
	it("does not start dictation while the conversation holds the microphone", async () => {
		const onDictationStart = vi.fn();
		const { container } = renderTalkDock({ onDictationStart });
		fireEvent.click(q(container, "talk-start") as HTMLElement);
		await waitFor(() => expect(talkStore.active()).toBe(true));
		fireEvent.click(q(container, "compose-type") as HTMLElement);

		const mic = q(container, "compose-mic") as HTMLButtonElement;
		expect(mic.disabled).toBe(true);
		fireEvent.click(mic);
		expect(onDictationStart).not.toHaveBeenCalled();
	});

	it("says why when the voice cannot start, and stays a bar", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "voice_start") throw new Error("Failed to open an audio output device");
			return voiceInstallAnswer(cmd);
		});
		// Stubbed: a real toast would leave its dismiss timer running after the test.
		const added = vi.spyOn(toastsStore, "add").mockImplementation(() => 0);
		try {
			const { container } = renderTalkDock();
			fireEvent.click(q(container, "talk-start") as HTMLElement);

			await waitFor(() => expect(added).toHaveBeenCalled());
			expect(added.mock.calls[0]?.[0]).toBe("Could not start the conversation");
			expect(String(added.mock.calls[0]?.[1])).toContain("audio output device");
			expect(container.querySelector('[data-testid="compose-bar"]')).not.toBeNull();
			expect(talkStore.active()).toBe(false);
		} finally {
			added.mockRestore();
		}
	});

	// Catches: Talk failing with "voice is not downloaded" on a new install, or
	// worse, starting a 660 MB download nobody agreed to.
	it("asks before downloading when voice is not set up, and opens no microphone", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => voiceInstallAnswer(cmd, { speech: false, voice: false }));
		const { container } = renderTalkDock();

		fireEvent.click(q(container, "talk-start") as HTMLElement);

		await waitFor(() => expect(q(container, "talk-setup-download")).not.toBeNull());
		expect(q(container, "talk-words")?.textContent).toContain("one-time download of about 660 MB");
		expect(calls("voice_start")).toBe(0);
		expect(calls("download_whisper_model")).toBe(0);

		fireEvent.click(q(container, "talk-setup-later") as HTMLElement);
		await waitFor(() => expect(container.querySelector('[data-testid="compose-bar"]')).not.toBeNull());
	});

	it("starts the conversation from the round button of an empty card", async () => {
		const { container } = renderTalkDock();
		fireEvent.click(q(container, "compose-type") as HTMLElement);

		fireEvent.click(q(container, "compose-voice") as HTMLElement);

		await waitFor(() => expect(talkStore.active()).toBe(true));
		// The empty card folds away so the conversation has the row.
		expect(container.querySelector('[data-testid="compose-input"]')).toBeNull();
	});
});

describe("ComposeDock (hero)", () => {
	const targets = () =>
		buildStartTargets([
			{ type: "claude", name: "Claude Code", command: "claude" },
			{ type: "codex", name: "Codex CLI", command: "codex" },
		]);

	it("asks what to build in the active repo and starts the chosen agent on Enter", async () => {
		repositoriesStore.add({ path: REPO, displayName: "demo", initials: "DE" });
		repositoriesStore.setActive(REPO);
		const onStart = vi.fn();
		const { container } = render(() => (
			<ComposeDock
				variant="hero"
				onDictationStart={vi.fn()}
				onDictationStop={vi.fn()}
				startTargets={targets}
				onStart={onStart}
			/>
		));
		expect(container.querySelector("h1")?.textContent).toBe("What should we build in demo?");
		const picker = container.querySelector('[data-testid="compose-start-target"]') as HTMLSelectElement;
		expect(Array.from(picker.options).map((o) => o.value)).toEqual(["claude", "codex"]);
		fireEvent.change(picker, { target: { value: "codex" } });

		const field = input(container);
		expect(field.placeholder).toBe("Speak or type what to build");
		type(field, "add a health route");
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
		const [target, text] = onStart.mock.calls[0]!;
		expect((target as StartTarget).id).toBe("codex");
		expect(text).toBe("add a health route");
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
	});

	it("is disabled, and says why, when no prompt-taking agent is installed", () => {
		repositoriesStore.add({ path: REPO, displayName: "demo", initials: "DE" });
		repositoriesStore.setActive(REPO);
		const { container } = render(() => (
			<ComposeDock variant="hero" onDictationStart={vi.fn()} onDictationStop={vi.fn()} startTargets={() => []} />
		));
		expect(input(container).disabled).toBe(true);
		expect(input(container).placeholder).toBe("Install Claude Code or Codex CLI to start an agent from here");
		expect(container.querySelector('[data-testid="compose-start-target"]')).toBeNull();
	});

	it("is disabled until a repository exists", () => {
		const { container } = render(() => (
			<ComposeDock variant="hero" onDictationStart={vi.fn()} onDictationStop={vi.fn()} startTargets={targets} />
		));
		expect(container.querySelector("h1")?.textContent).toBe("What should we build?");
		expect(input(container).disabled).toBe(true);
		expect(input(container).placeholder).toBe("Add a repository to start");
	});
});

/**
 * FastAF's dock is the one input for the active terminal, Chat view included:
 * Chat does not bring back upstream's own composer while the dock is on screen
 * (Terminal.tsx), so the dock must deliver a Chat prompt exactly as that
 * composer did.
 */
describe("ComposeDock in front of the Chat view", () => {
	const renderDock = () =>
		render(() => <ComposeDock variant="dock" onDictationStart={vi.fn()} onDictationStop={vi.fn()} />);
	const sendFromDock = (container: HTMLElement, text: string) => {
		fireEvent.click(container.querySelector('[data-testid="compose-type"]') as HTMLButtonElement);
		type(input(container), text);
		fireEvent.keyDown(input(container), { key: "Enter" });
	};
	const chatTerminal = (sessionId: string, patch: Parameters<typeof terminalsStore.update>[1] = {}) => {
		const id = addTerminal("Claude Code", "claude", sessionId);
		terminalsStore.update(id, patch);
		terminalsStore.setViewMode(id, "chat");
		terminalsStore.setActive(id);
		return id;
	};

	afterEach(() => vi.restoreAllMocks());

	// Catches: a Chat prompt typed into the hidden agent box mid-turn instead of the queue the transcript lists.
	it("queues a prompt sent while the agent works, and refreshes the transcript's queue", async () => {
		const refresh = vi.spyOn(chatViewStore, "refreshQueue").mockResolvedValue();
		chatTerminal("session-busy", { shellState: "busy" });
		const { container } = renderDock();
		sendFromDock(container, "then add a test");
		await waitFor(() => expect(ptyMocks.enqueueCommand).toHaveBeenCalledWith("session-busy", "then add a test"));
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledWith("session-busy");
	});

	// Catches: the dock reaching the agent while the open transcript never shows the prompt was sent.
	it("sends to an idle agent now and shows the prompt pending in the transcript", async () => {
		const rollback = vi.fn();
		const begin = vi.spyOn(chatViewStore, "beginSubmission").mockReturnValue(rollback);
		chatTerminal("session-idle", { shellState: "idle" });
		const { container } = renderDock();
		sendFromDock(container, "explain the retry loop");
		await waitFor(() =>
			expect(ptyMocks.sendCommand).toHaveBeenCalledWith("session-idle", "explain the retry loop", "claude"),
		);
		expect(begin).toHaveBeenCalledWith("session-idle", "explain the retry loop");
		expect(rollback).not.toHaveBeenCalled();
		expect(ptyMocks.enqueueCommand).not.toHaveBeenCalled();
	});

	// Catches: a failed send leaving a pending turn in the transcript for a prompt nobody received.
	it("takes the pending turn back, and keeps the draft, when the send fails", async () => {
		const rollback = vi.fn();
		vi.spyOn(chatViewStore, "beginSubmission").mockReturnValue(rollback);
		// The failure toast's auto-dismiss timer would outlive the test.
		const toast = vi.spyOn(toastsStore, "add").mockImplementation(() => 1);
		ptyMocks.sendCommand.mockRejectedValueOnce(new Error("pty gone"));
		chatTerminal("session-fail", { shellState: "idle" });
		const { container } = renderDock();
		sendFromDock(container, "still here");
		await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
		expect(input(container).value).toBe("still here");
		expect(toast).toHaveBeenCalledWith("Could not send to the terminal", "Error: pty gone", "error");
	});

	// Catches: an answer to the agent's own question parked behind the turn that is waiting for it.
	it("answers a waiting agent right away even though it reads as busy", () => {
		expect(
			dockSendMode({ agentType: "claude", viewMode: "chat", shellState: "busy", awaitingInput: "question" }, "now"),
		).toBe("now");
		expect(dockSendMode({ agentType: "claude", viewMode: "cli", shellState: "busy", awaitingInput: null }, "now")).toBe(
			"now",
		);
		expect(
			dockSendMode({ agentType: "claude", viewMode: "chat", shellState: "busy", awaitingInput: null }, "now"),
		).toBe("queue");
		expect(dockSendMode({ agentType: null, viewMode: "cli", shellState: "busy", awaitingInput: null }, "queue")).toBe(
			"now",
		);
		expect(
			dockSendMode({ agentType: "codex", viewMode: "cli", shellState: "idle", awaitingInput: null }, "queue"),
		).toBe("queue");
	});

	// Catches: Chat typing, the compose shortcut or a smart prompt having nowhere to go once Chat's own composer is gone.
	it("lets the terminal open it with typed text or a replacement draft, and leaves when unmounted", () => {
		chatTerminal("session-open");
		const { container, unmount } = renderDock();
		expect(composeDockBridge.present()).toBe(true);
		expect(composeDockBridge.open({ insert: "h" })).toBe(true);
		const field = input(container);
		expect(field.value).toBe("h");
		expect(document.activeElement).toBe(field);
		expect(composeDockBridge.open({ insert: "i" })).toBe(true);
		expect(field.value).toBe("hi");
		expect(composeDockBridge.open({ replace: "Review the diff" })).toBe(true);
		expect(input(container).value).toBe("Review the diff");
		unmount();
		expect(composeDockBridge.present()).toBe(false);
		expect(composeDockBridge.open({ insert: "x" })).toBe(false);
	});

	// Catches: typing swallowed into a dock that cannot send (no session), with the keystroke lost.
	it("refuses to open while the active terminal has no session", () => {
		const id = chatTerminal("");
		terminalsStore.update(id, { sessionId: null });
		const { container } = renderDock();
		expect(composeDockBridge.open({ insert: "h" })).toBe(false);
		expect(container.querySelector('[data-testid="compose-input"]')).toBeNull();
	});
});
