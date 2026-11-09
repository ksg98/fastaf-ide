import { createSignal } from "solid-js";
import { listen } from "../invoke";
import { SentenceChunker } from "../utils/sentenceChunker";
import { spokenAnswer } from "../utils/spokenAnswer";
import { appLogger } from "./appLogger";
import { conversationStore, type TurnOptions } from "./conversationStore";
import { voiceStore } from "./voice";

/** What an open chat panel tells the conversation about itself. */
export interface TalkBinding {
	/** Session the turn should be sent to. */
	sessionId: () => string | null;
	/** "assisted" or "autonomous" — decides which store action runs. */
	autonomy: () => string;
	/** Per-turn model/effort overrides from the chat header. */
	turnOptions: () => TurnOptions;
}

/** The terminal something happened in, in the user's words. */
export interface TalkTarget {
	terminalId: string;
	/** The agent running in that terminal, else the terminal's own name. */
	recipient: string;
	/** The repository the terminal belongs to. */
	place: string | null;
}

export type TalkChipKind = "sent" | "key" | "ran" | "started" | "approved" | "denied";

/** One thing the conversation did, shown briefly above the orb. */
export interface TalkChip {
	id: number;
	kind: TalkChipKind;
	/** Where it happened. Null when the terminal is not one this window knows. */
	target: TalkTarget | null;
	/** `key` only: the key that was pressed. */
	detail?: string;
}

/** The words on screen: the last thing you said, or what the agent is saying. */
export interface TalkCaption {
	who: "you" | "agent";
	text: string;
}

/** What the controller needs to know about the window it lives in. */
export interface TalkEnvironment {
	/** Session a turn goes to when no chat panel is open to say otherwise. */
	defaultSessionId: () => string | null;
	/** Name the terminal behind a PTY session, for the action chips. */
	describeSession: (sessionId: string) => TalkTarget | null;
	/** Something was just done in this terminal; the window may point at it. */
	onAction?: (target: TalkTarget) => void;
	/**
	 * A question from an agent in some terminal that a yes or a no settles
	 * ("FastAF speaks first"). While one is waiting, a spoken yes or no goes
	 * to it instead of becoming a message.
	 */
	ask?: () => { target: TalkTarget; answer: (approved: boolean) => void } | null;
}

/**
 * How long to wait for an in-flight turn to finish before dropping a new
 * utterance. Speaking over a reply normally cancels it (barge-in), so this only
 * covers the window where transcription finished first.
 */
const BUSY_WAIT_MS = 4000;
/** How long an action chip stays up. */
export const CHIP_MS = 5000;
/** Chips on screen at once; the oldest gives way. */
const MAX_CHIPS = 3;

const stringArg = (args: Record<string, unknown>, key: string): string | null => {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value : null;
};

/**
 * Talk mode: one hands-free conversation for the whole window.
 *
 * Rust owns the microphone, turn detection and transcription and emits
 * `voice-partial` while you speak and `voice-utterance` when you stop; this
 * decides what to do with the text, turns the reply
 * back into speech sentence by sentence as it streams, and keeps what the dock
 * shows while that happens — the caption and the action chips.
 *
 * It used to live inside the AI Chat panel, which made the panel the only
 * place a conversation could start or be seen. The panel now only lends its
 * settings (`bind`) while it is open.
 */
export function createTalkController(env: TalkEnvironment) {
	const [active, setActive] = createSignal(false);
	/** The session is being brought up: the engine loads before the microphone opens. */
	const [starting, setStarting] = createSignal(false);
	const [caption, setCaption] = createSignal<TalkCaption | null>(null);
	const [chips, setChips] = createSignal<TalkChip[]>([]);
	const chunker = new SentenceChunker();
	/** Open chat panels, oldest first. The newest one's settings apply. */
	const bindings: TalkBinding[] = [];
	const chipTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let nextChipId = 1;
	/** The reply now being spoken has a caption: further sentences extend it. */
	let replying = false;

	const binding = (): TalkBinding =>
		bindings.at(-1) ?? {
			sessionId: env.defaultSessionId,
			autonomy: () => "assisted",
			turnOptions: () => ({}),
		};

	const busy = () =>
		binding().autonomy() === "autonomous"
			? ["running", "paused"].includes(conversationStore.agentState())
			: conversationStore.isStreaming();

	const waitForIdle = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (busy() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return !busy();
	};

	// --- Chips ------------------------------------------------------------

	const dismissChip = (id: number) => {
		const timer = chipTimers.get(id);
		if (timer) clearTimeout(timer);
		chipTimers.delete(id);
		setChips((prev) => prev.filter((chip) => chip.id !== id));
	};

	const pushChip = (kind: TalkChipKind, target: TalkTarget | null, detail?: string) => {
		const chip: TalkChip = { id: nextChipId++, kind, target, detail };
		if (target) env.onAction?.(target);
		setChips((prev) => {
			const next = [...prev, chip];
			for (const dropped of next.slice(0, Math.max(0, next.length - MAX_CHIPS))) {
				const timer = chipTimers.get(dropped.id);
				if (timer) clearTimeout(timer);
				chipTimers.delete(dropped.id);
			}
			return next.slice(-MAX_CHIPS);
		});
		chipTimers.set(
			chip.id,
			setTimeout(() => dismissChip(chip.id), CHIP_MS),
		);
	};

	/** Only the calls that change a terminal are worth a chip; reads are noise. */
	const chipForToolCall = (toolName: string, args: Record<string, unknown>) => {
		const sessionId = stringArg(args, "session_id");
		const target = sessionId ? env.describeSession(sessionId) : null;
		switch (toolName) {
			case "send_input":
				pushChip("sent", target);
				break;
			case "drive_agent":
				// Without a command it only waits and reads.
				if (stringArg(args, "command")) pushChip("sent", target);
				break;
			case "send_key":
				pushChip("key", target, stringArg(args, "key") ?? undefined);
				break;
			case "run_command": {
				const own = binding().sessionId();
				pushChip("ran", own ? env.describeSession(own) : null);
				break;
			}
			case "spawn_session":
				pushChip("started", null, stringArg(args, "name") ?? undefined);
				break;
		}
	};

	// --- Turns ------------------------------------------------------------

	/** Abandon the turn in progress. */
	const cancelTurn = () => {
		if (!busy()) return;
		if (binding().autonomy() === "autonomous") {
			const sid = binding().sessionId();
			if (sid) void conversationStore.cancelAgent(sid);
		} else {
			void conversationStore.cancelStream();
		}
	};

	/** Stop speaking and abandon the turn in progress. */
	const bargeIn = () => {
		chunker.reset();
		replying = false;
		voiceStore.cancelSpeech();
		cancelTurn();
	};

	const sendUtterance = async (text: string) => {
		// Muting drops the microphone in Rust, but a turn that finished
		// transcribing just before the mute lands is already on its way here.
		// Muting mid-sentence means "don't send that", so drop it — including
		// after the wait below, which can hold an utterance for seconds.
		if (!active() || voiceStore.state.muted) return;
		replying = false;
		setCaption({ who: "you", text });

		// An agent in a terminal asked a yes-or-no question and FastAF read it
		// out: a short answer goes to that agent.
		const asked = env.ask?.();
		if (asked) {
			const answer = spokenAnswer(text);
			if (answer !== null) {
				asked.answer(answer);
				pushChip(answer ? "approved" : "denied", asked.target);
				return;
			}
		}

		// Something is waiting on a yes or no: a short answer settles it.
		const pending = conversationStore.pendingApproval();
		if (pending) {
			const answer = spokenAnswer(text);
			if (answer !== null) {
				void conversationStore.approveAction(pending.sessionId, answer);
				pushChip(answer ? "approved" : "denied", env.describeSession(pending.sessionId));
				return;
			}
			// Anything else replaces the request that was waiting.
			cancelTurn();
		}

		const idle = await waitForIdle(BUSY_WAIT_MS);
		if (!idle || !active() || voiceStore.state.muted) {
			// Length only — transcripts never reach the log.
			appLogger.warn("voice", `Dropped a ${text.length}-char utterance; chat still busy`);
			return;
		}
		const sid = binding().sessionId();
		voiceStore.setAgentState("thinking");
		chunker.reset();
		if (binding().autonomy() === "autonomous") {
			if (sid) {
				conversationStore.startAgent(sid, text, conversationStore.unrestricted(), binding().turnOptions());
			}
		} else {
			void conversationStore.sendMessage(text, sid, binding().turnOptions());
		}
	};

	/** Speak one sentence of the reply and put it on screen. */
	const say = (sentence: string) => {
		voiceStore.speak(sentence);
		setCaption((prev) =>
			replying && prev?.who === "agent"
				? { who: "agent", text: `${prev.text} ${sentence}` }
				: { who: "agent", text: sentence },
		);
		replying = true;
	};

	/**
	 * Say something of its own accord, through the running conversation: an
	 * agent needs the user, or has finished. Its own caption; the next reply
	 * starts a fresh one.
	 */
	const announce = (sentence: string) => {
		if (!active()) return;
		replying = false;
		say(sentence);
		replying = false;
	};

	// --- Rust -> here -----------------------------------------------------

	const unlistenUtterance = listen<{ text: string }>("voice-utterance", (event) => {
		const text = event.payload.text.trim();
		if (text) void sendUtterance(text);
	});

	// The turn so far, while it is still being spoken — so the dock shows that
	// it is hearing you, not only that it heard you. Local speech recognition
	// only; with a cloud provider the words arrive with `voice-utterance`.
	const unlistenPartial = listen<{ text: string }>("voice-partial", (event) => {
		const text = event.payload.text.trim();
		if (!text || !active() || voiceStore.state.muted) return;
		replying = false;
		setCaption({ who: "you", text });
	});

	// Only meaningful with barge-in enabled; in half-duplex mode Rust suppresses
	// the microphone while speaking, so this never fires mid-reply.
	const unlistenSpeechStart = listen("voice-speech-start", () => {
		if (!active()) return;
		// Answering an approval out loud must not cancel the turn that asked.
		if (conversationStore.pendingApproval()) {
			chunker.reset();
			replying = false;
			voiceStore.cancelSpeech();
			return;
		}
		bargeIn();
	});

	// --- Reply -> speech --------------------------------------------------

	const stopObserving = conversationStore.observeReply({
		onDelta: (text) => {
			if (!active()) return;
			voiceStore.setAgentState("speaking");
			for (const sentence of chunker.feed(text)) say(sentence);
		},
		onTurnEnd: () => {
			if (!active()) {
				chunker.reset();
				return;
			}
			const rest = chunker.flush();
			if (rest) say(rest);
			replying = false;
			// Not "listening" yet — the reply text is complete but its audio is
			// still queued. The status poll flips it back once the speaker
			// actually goes quiet.
		},
		onToolCall: (toolName, args) => {
			if (active()) chipForToolCall(toolName, args);
		},
	});

	// --- Control ----------------------------------------------------------

	const clearScreen = () => {
		for (const timer of chipTimers.values()) clearTimeout(timer);
		chipTimers.clear();
		setChips([]);
		setCaption(null);
		replying = false;
	};

	const start = async () => {
		if (active() || starting()) return;
		chunker.reset();
		clearScreen();
		setStarting(true);
		try {
			await voiceStore.startSession();
			setActive(true);
		} catch {
			// startSession already recorded the reason in voiceStore.state.error.
			setActive(false);
		} finally {
			setStarting(false);
		}
	};

	const stop = async () => {
		setActive(false);
		chunker.reset();
		clearScreen();
		voiceStore.cancelSpeech();
		await voiceStore.stopSession();
	};

	const toggle = () => {
		if (active()) void stop();
		else void start();
	};

	/** On screen: running, or on its way up. */
	const engaged = () => active() || starting();

	/**
	 * Lend a chat panel's settings to the conversation for as long as the panel
	 * is open. Returns the function that takes them back.
	 */
	const bind = (panel: TalkBinding): (() => void) => {
		bindings.push(panel);
		return () => {
			const index = bindings.indexOf(panel);
			if (index !== -1) bindings.splice(index, 1);
		};
	};

	/** Release every listener. The app never calls this; tests do. */
	const dispose = () => {
		void Promise.resolve(unlistenUtterance).then((un) => un?.());
		void Promise.resolve(unlistenPartial).then((un) => un?.());
		void Promise.resolve(unlistenSpeechStart).then((un) => un?.());
		stopObserving();
		for (const timer of chipTimers.values()) clearTimeout(timer);
		chipTimers.clear();
	};

	return {
		active,
		starting,
		engaged,
		caption,
		chips,
		start,
		stop,
		toggle,
		bargeIn,
		announce,
		bind,
		dismissChip,
		dispose,
	};
}

export type TalkController = ReturnType<typeof createTalkController>;
