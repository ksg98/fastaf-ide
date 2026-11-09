import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stage is a view over four stores. Each is replaced by signals the tests
// drive, so every assertion is about what the stage draws for a given state.
const world = vi.hoisted(() => ({
	voice: null as unknown as {
		set: (patch: Record<string, unknown>) => void;
		toggleMuted: ReturnType<typeof vi.fn>;
	},
	talk: null as unknown as {
		setCaption: (c: { who: "you" | "agent"; text: string } | null) => void;
		setChips: (c: unknown[]) => void;
		setFleet: (f: { working: number; waiting: string[] }) => void;
		setEngaged: (on: boolean) => void;
		stop: ReturnType<typeof vi.fn>;
		bargeIn: ReturnType<typeof vi.fn>;
		startTalk: ReturnType<typeof vi.fn>;
	},
	setup: null as unknown as {
		set: (patch: Record<string, unknown>) => void;
		setNeeds: (n: Record<string, boolean>) => void;
		setMb: (mb: number) => void;
		run: ReturnType<typeof vi.fn>;
		dismiss: ReturnType<typeof vi.fn>;
	},
	ask: null as unknown as {
		setPending: (a: unknown) => void;
		answer: ReturnType<typeof vi.fn>;
	},
	chat: null as unknown as {
		setPending: (p: { sessionId: string; command: string; reason: string } | null) => void;
		setError: (e: string | null) => void;
		approveAction: ReturnType<typeof vi.fn>;
	},
}));

vi.mock("../../stores/voice", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({
		agentState: "listening",
		muted: false,
		audioLevel: 0,
		outputLevel: 0,
		error: "",
	});
	const toggleMuted = vi.fn();
	world.voice = { set: (patch) => setState(patch), toggleMuted };
	return { voiceStore: { state, toggleMuted } };
});

vi.mock("../../stores/talk", async () => {
	const { createSignal } = await import("solid-js");
	const [caption, setCaption] = createSignal<{ who: "you" | "agent"; text: string } | null>(null);
	const [chips, setChips] = createSignal<unknown[]>([]);
	const [fleet, setFleet] = createSignal({ working: 0, waiting: [] as string[] });
	const [engaged, setEngaged] = createSignal(true);
	const stop = vi.fn().mockResolvedValue(undefined);
	const bargeIn = vi.fn();
	const startTalk = vi.fn().mockResolvedValue(undefined);
	world.talk = { setCaption, setChips, setFleet, setEngaged, stop, bargeIn, startTalk };
	return { talkStore: { caption, chips, engaged, stop, bargeIn }, agentFleet: () => fleet(), startTalk };
});

vi.mock("../../stores/voiceSetup", async () => {
	const { createStore } = await import("solid-js/store");
	const { createSignal } = await import("solid-js");
	const [state, setState] = createStore({ offered: false, running: false, step: "idle", error: null as string | null });
	const [needs, setNeeds] = createSignal({ dictation: false, speech: false, voice: false, chat: false, brain: false });
	const run = vi.fn().mockResolvedValue(true);
	const dismiss = vi.fn(() => setState({ offered: false, step: "idle", error: null }));
	const [mb, setMb] = createSignal(660);
	world.setup = {
		set: (patch) => setState(patch),
		setNeeds: (n) => setNeeds((prev) => ({ ...prev, ...n })),
		setMb,
		run,
		dismiss,
	};
	return { voiceSetup: { state, needs, run, dismiss, percent: () => 42, downloadMb: () => mb() } };
});

vi.mock("../../stores/conversationStore", async () => {
	const { createSignal } = await import("solid-js");
	const [pending, setPending] = createSignal<{ sessionId: string; command: string; reason: string } | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const approveAction = vi.fn().mockResolvedValue(undefined);
	world.chat = { setPending, setError, approveAction };
	return { conversationStore: { pendingApproval: pending, error, approveAction } };
});

vi.mock("../../stores/agentAsk", async () => {
	const { createSignal } = await import("solid-js");
	const [pending, setPending] = createSignal<unknown>(null);
	const answer = vi.fn().mockResolvedValue(true);
	world.ask = { setPending, answer };
	return { agentAsk: { pending, answer } };
});

import { AskStrip, TalkButton, TalkStage } from "../../components/ComposeDock/TalkStage";

const byId = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

beforeEach(() => {
	world.voice.set({ agentState: "listening", muted: false, error: "" });
	world.voice.toggleMuted.mockClear();
	world.talk.setCaption(null);
	world.talk.setChips([]);
	world.talk.setFleet({ working: 0, waiting: [] });
	world.talk.stop.mockClear();
	world.talk.bargeIn.mockClear();
	world.chat.setPending(null);
	world.chat.setError(null);
	world.chat.approveAction.mockClear();
	world.ask.setPending(null);
	world.ask.answer.mockClear();
	world.talk.setEngaged(true);
	world.talk.startTalk.mockClear();
	world.setup.set({ offered: false, running: false, step: "idle", error: null });
	world.setup.setNeeds({ brain: false });
	world.setup.run.mockClear().mockResolvedValue(true);
	world.setup.dismiss.mockClear();
	world.setup.setMb(660);
});

afterEach(cleanup);

describe("TalkButton", () => {
	it("is the way in: an orb, the word Talk, and the shortcut", () => {
		const onClick = vi.fn();
		const { container } = render(() => <TalkButton hotkey="⌥⌘V" onClick={onClick} />);
		const button = byId(container, "talk-start") as HTMLButtonElement;

		expect(button.textContent).toContain("Talk");
		expect(button.textContent).toContain("⌥⌘V");
		expect(button.querySelector("canvas")).toBeTruthy();

		button.click();
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("cannot be pressed when there is no terminal to talk about", () => {
		const onClick = vi.fn();
		const { container } = render(() => <TalkButton disabled onClick={onClick} />);
		(byId(container, "talk-start") as HTMLButtonElement).click();
		expect(onClick).not.toHaveBeenCalled();
	});
});

describe("TalkStage words", () => {
	it("invites speech while it is listening and nothing has been said", () => {
		const { container } = render(() => <TalkStage />);
		expect(byId(container, "talk-who")?.textContent).toBe("FastAF");
		expect(byId(container, "talk-state")?.textContent).toBe("Listening");
		expect(byId(container, "talk-words")?.textContent).toBe("Just talk. I am listening.");
	});

	it("shows your words under your name, with no state beside it", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setCaption({ who: "you", text: "are the tests green" });

		expect(byId(container, "talk-who")?.textContent).toBe("You");
		expect(byId(container, "talk-state")).toBeNull();
		expect(byId(container, "talk-words")?.textContent).toBe("are the tests green");
	});

	// Catches: your sentence relabelled as FastAF's while it is still thinking
	// about it, before it has said a word.
	it("keeps your words under your name while it thinks", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setCaption({ who: "you", text: "are the tests green" });
		world.voice.set({ agentState: "thinking" });

		expect(byId(container, "talk-who")?.textContent).toBe("You");
		expect(byId(container, "talk-words")?.textContent).toBe("are the tests green");
	});

	it("shows what it is saying under its own name", () => {
		const { container } = render(() => <TalkStage />);
		world.voice.set({ agentState: "speaking" });
		world.talk.setCaption({ who: "agent", text: "Yes, all fourteen pass." });

		expect(byId(container, "talk-who")?.textContent).toBe("FastAF");
		expect(byId(container, "talk-state")?.textContent).toBe("Speaking");
		expect(byId(container, "talk-words")?.textContent).toBe("Yes, all fourteen pass.");
	});

	it("says it cannot hear you while muted, whatever was said last", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setCaption({ who: "you", text: "old words" });
		world.voice.set({ agentState: "muted", muted: true });

		expect(byId(container, "talk-words")?.textContent).toBe("Muted. FastAF cannot hear you.");
		expect(byId(container, "talk-mute")?.getAttribute("aria-pressed")).toBe("true");
	});

	// Catches: a chat failure (no provider, no terminal attached) leaving the
	// stage listening happily while every sentence goes nowhere.
	it("puts a failure where the words would be", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setCaption({ who: "you", text: "hello" });
		world.chat.setError("No model is configured for AI Chat");

		expect(byId(container, "talk-who")?.textContent).toBe("FastAF");
		expect(byId(container, "talk-words")?.textContent).toBe("No model is configured for AI Chat");
	});

	it("shows why the voice session stopped", () => {
		const { container } = render(() => <TalkStage />);
		world.voice.set({ agentState: "error", error: "Whisper model is not downloaded" });

		expect(byId(container, "talk-state")?.textContent).toBe("Error");
		expect(byId(container, "talk-words")?.textContent).toBe("Whisper model is not downloaded");
	});
});

describe("TalkStage approvals", () => {
	const pending = { sessionId: "sess-1", command: "rm -rf data/cache", reason: "destructive" };

	it("asks for the answer out loud or by click, and names the command", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setFleet({ working: 2, waiting: [] });
		world.chat.setPending(pending);

		expect(byId(container, "talk-words")?.textContent).toBe("Wants to run rm -rf data/cache. Approve?");
		// Not "Thinking": it has stopped, and what it is waiting for is you.
		expect(byId(container, "talk-state")?.textContent).toBe("Asking");
		expect(byId(container, "talk-approve")).toBeTruthy();
		expect(byId(container, "talk-deny")).toBeTruthy();
		// The agent count gives its place to the two answers.
		expect(byId(container, "talk-working")).toBeNull();
	});

	it("sends the clicked answer for the session that asked", () => {
		const { container } = render(() => <TalkStage />);
		world.chat.setPending(pending);

		byId(container, "talk-approve")?.click();
		expect(world.chat.approveAction).toHaveBeenLastCalledWith("sess-1", true);

		byId(container, "talk-deny")?.click();
		expect(world.chat.approveAction).toHaveBeenLastCalledWith("sess-1", false);
	});
});

describe("TalkStage voice setup", () => {
	/** Talk was pressed on an install with no speech model or voice on disk. */
	const offer = () => {
		world.talk.setEngaged(false);
		world.setup.set({ offered: true });
	};

	// Catches: the answer to "Talk" being a settings page, or a download that
	// starts without the size ever being said.
	it("asks before downloading, saying how much and that speech stays local", () => {
		const { container } = render(() => <TalkStage />);
		offer();

		expect(byId(container, "talk-state")?.textContent).toBe("Voice setup");
		expect(byId(container, "talk-words")?.textContent).toBe(
			"Talking needs a one-time download of about 660 MB. Speech stays on this Mac.",
		);
		expect(byId(container, "talk-setup-download")?.textContent).toBe("Download");
		expect(world.setup.run).not.toHaveBeenCalled();
		// Nothing to mute or read yet.
		expect(byId(container, "talk-mute")).toBeNull();
	});

	// Catches: "a one-time download of about 0 MB" on a machine that has the
	// models and only has AI Chat switched off.
	it("asks only to switch AI Chat on when there is nothing to download", () => {
		const { container } = render(() => <TalkStage />);
		world.setup.setMb(0);
		offer();

		expect(byId(container, "talk-words")?.textContent).toBe(
			"Talking is a conversation with AI Chat, which is switched off. Turn it on?",
		);
		expect(byId(container, "talk-setup-download")?.textContent).toBe("Turn on");
	});

	it("downloads on the click and then starts the conversation that was asked for", async () => {
		const { container } = render(() => <TalkStage />);
		offer();

		byId(container, "talk-setup-download")?.click();

		await vi.waitFor(() => expect(world.talk.startTalk).toHaveBeenCalledOnce());
		expect(world.setup.run).toHaveBeenCalledOnce();
	});

	it("does not start a conversation when the download failed", async () => {
		world.setup.run.mockResolvedValue(false);
		const { container } = render(() => <TalkStage />);
		offer();

		byId(container, "talk-setup-download")?.click();
		await vi.waitFor(() => expect(world.setup.run).toHaveBeenCalled());
		await Promise.resolve();

		expect(world.talk.startTalk).not.toHaveBeenCalled();
	});

	it("shows the progress, and offers nothing to press while it downloads", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setEngaged(false);
		world.setup.set({ running: true, step: "speech" });

		expect(byId(container, "talk-state")?.textContent).toBe("Setting up");
		expect(byId(container, "talk-words")?.textContent).toBe("Getting speech ready · 42%");
		expect(byId(container, "talk-setup-download")).toBeNull();
		expect(byId(container, "talk-end")).toBeNull();
	});

	it("says what went wrong and offers to try again", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setEngaged(false);
		world.setup.set({ step: "failed", error: "The speech model could not be downloaded." });

		expect(byId(container, "talk-words")?.textContent).toBe("The speech model could not be downloaded.");
		expect(byId(container, "talk-setup-download")?.textContent).toBe("Try again");
	});

	it("takes Not now for an answer, from the button and from the close button", () => {
		const { container } = render(() => <TalkStage />);
		offer();
		byId(container, "talk-setup-later")?.click();
		expect(world.setup.dismiss).toHaveBeenCalledOnce();

		offer();
		byId(container, "talk-end")?.click();
		expect(world.setup.dismiss).toHaveBeenCalledTimes(2);
		expect(world.talk.stop).not.toHaveBeenCalled();
	});

	// Catches: a conversation that opens the microphone, listens, and then
	// answers every sentence with a provider error nobody can act on.
	it("says so up front when AI Chat has no model, and points at where to connect one", () => {
		const onOpenSettings = vi.fn();
		const { container } = render(() => <TalkStage onOpenSettings={onOpenSettings} />);
		world.setup.setNeeds({ brain: true });

		expect(byId(container, "talk-words")?.textContent).toBe(
			"AI Chat has no model to think with yet. Connect one to talk.",
		);
		byId(container, "talk-connect-model")?.click();
		expect(onOpenSettings).toHaveBeenCalledWith("providers");
	});
});

describe("an agent's own question", () => {
	const question = {
		target: { terminalId: "term-4", recipient: "Claude Code", place: "ml-pipeline" },
		sessionId: "sess-4",
		title: "Do you want to run rm -rf data/cache?",
		approveKey: "1",
		denyKey: "3",
	};

	it("is offered at rest in the orb's place: who asks, and the two answers", () => {
		const onFocusTerminal = vi.fn();
		const { container } = render(() => <AskStrip onFocusTerminal={onFocusTerminal} />);
		expect(byId(container, "talk-ask")).toBeNull();

		world.ask.setPending(question);
		expect(byId(container, "talk-ask-show")?.textContent).toBe("Claude Code in ml-pipeline needs you");
		// The full question is one hover away; the row has no room for it.
		expect(byId(container, "talk-ask-show")?.getAttribute("title")).toBe(question.title);

		byId(container, "talk-ask-approve")?.click();
		expect(world.ask.answer).toHaveBeenLastCalledWith(true);
		byId(container, "talk-ask-deny")?.click();
		expect(world.ask.answer).toHaveBeenLastCalledWith(false);

		byId(container, "talk-ask-show")?.click();
		expect(onFocusTerminal).toHaveBeenCalledWith("term-4");
	});

	it("is read out in the conversation and answered from the same two buttons", () => {
		const { container } = render(() => <TalkStage />);
		world.ask.setPending(question);

		expect(byId(container, "talk-state")?.textContent).toBe("Asking");
		expect(byId(container, "talk-words")?.textContent).toBe(
			"Claude Code in ml-pipeline: Do you want to run rm -rf data/cache?",
		);
		byId(container, "talk-approve")?.click();
		expect(world.ask.answer).toHaveBeenCalledWith(true);
		expect(world.chat.approveAction).not.toHaveBeenCalled();
	});

	// Catches: one click answering the wrong one of two waiting questions.
	it("waits behind an approval FastAF's own agent asked for", () => {
		const { container } = render(() => <TalkStage />);
		world.ask.setPending(question);
		world.chat.setPending({ sessionId: "sess-1", command: "git push", reason: "network" });

		expect(byId(container, "talk-words")?.textContent).toBe("Wants to run git push. Approve?");
		byId(container, "talk-approve")?.click();
		expect(world.chat.approveAction).toHaveBeenCalledWith("sess-1", true);
		expect(world.ask.answer).not.toHaveBeenCalled();
	});
});

describe("TalkStage agents", () => {
	it("counts the agents that are working and says when none is waiting", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setFleet({ working: 3, waiting: [] });

		expect(byId(container, "talk-working")?.textContent).toBe("3 working");
		expect(container.textContent).toContain("none waiting");
		expect(byId(container, "talk-waiting")).toBeNull();
	});

	it("takes you to the terminal that is waiting on you", () => {
		const onFocusTerminal = vi.fn();
		const { container } = render(() => <TalkStage onFocusTerminal={onFocusTerminal} />);
		world.talk.setFleet({ working: 1, waiting: ["term-7", "term-9"] });

		const waiting = byId(container, "talk-waiting");
		expect(waiting?.textContent).toBe("2 need you");
		waiting?.click();
		expect(onFocusTerminal).toHaveBeenCalledWith("term-7");
	});

	it("uses the singular for one waiting agent", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setFleet({ working: 0, waiting: ["term-7"] });
		expect(byId(container, "talk-waiting")?.textContent).toBe("1 needs you");
	});
});

describe("TalkStage chips", () => {
	const target = { terminalId: "term-2", recipient: "Claude Code", place: "api-gateway" };

	it("says what it did, to whom and where", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setChips([{ id: 1, kind: "sent", target }]);

		const chip = byId(container, "talk-chip");
		expect(chip?.textContent).toBe("Sent toClaude Code· api-gateway");
		expect(chip?.querySelector("b")?.textContent).toBe("Claude Code");
	});

	it("opens the terminal it acted on when clicked", () => {
		const onFocusTerminal = vi.fn();
		const { container } = render(() => <TalkStage onFocusTerminal={onFocusTerminal} />);
		world.talk.setChips([{ id: 1, kind: "approved", target }]);

		byId(container, "talk-chip")?.click();
		expect(onFocusTerminal).toHaveBeenCalledWith("term-2");
	});

	it("names the key it pressed", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setChips([{ id: 1, kind: "key", target, detail: "enter" }]);
		expect(byId(container, "talk-chip")?.textContent).toContain("Pressed enter in");
	});

	// Catches: a chip for a session this window does not know being a dead button.
	it("still reports an action in a terminal it cannot name, without a link", () => {
		const { container } = render(() => <TalkStage />);
		world.talk.setChips([{ id: 1, kind: "sent", target: null }]);

		const chip = byId(container, "talk-chip") as HTMLButtonElement;
		expect(chip.textContent).toBe("Sent to");
		expect(chip.disabled).toBe(true);
	});
});

describe("TalkStage controls", () => {
	it("mutes without ending the conversation", () => {
		const { container } = render(() => <TalkStage />);
		byId(container, "talk-mute")?.click();
		expect(world.voice.toggleMuted).toHaveBeenCalledOnce();
		expect(world.talk.stop).not.toHaveBeenCalled();
	});

	it("ends the conversation from the one bright button", () => {
		const { container } = render(() => <TalkStage />);
		byId(container, "talk-end")?.click();
		expect(world.talk.stop).toHaveBeenCalledOnce();
	});

	it("opens the written conversation when there is somewhere to open it", () => {
		const onOpenTranscript = vi.fn();
		const { container, unmount } = render(() => <TalkStage onOpenTranscript={onOpenTranscript} />);
		byId(container, "talk-transcript")?.click();
		expect(onOpenTranscript).toHaveBeenCalledOnce();
		unmount();

		const bare = render(() => <TalkStage />);
		expect(byId(bare.container, "talk-transcript")).toBeNull();
	});

	// Catches: a click on the orb cancelling nothing, or cancelling a turn that
	// is not there while it is only listening.
	it("lets a click on the orb stop a reply, and only a reply", () => {
		const { container } = render(() => <TalkStage />);
		const orb = byId(container, "talk-orb") as HTMLButtonElement;

		expect(orb.disabled).toBe(true);
		world.voice.set({ agentState: "speaking" });
		expect(orb.disabled).toBe(false);
		orb.click();
		expect(world.talk.bargeIn).toHaveBeenCalledOnce();
	});

	it("offers Type only when the dock asks for it", () => {
		const onType = vi.fn();
		const { container, unmount } = render(() => <TalkStage onType={onType} />);
		fireEvent.click(byId(container, "compose-type") as HTMLElement);
		expect(onType).toHaveBeenCalledOnce();
		unmount();

		const bare = render(() => <TalkStage />);
		expect(byId(bare.container, "compose-type")).toBeNull();
	});
});
