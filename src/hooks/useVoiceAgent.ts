import { createSignal, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { conversationStore, type TurnOptions } from "../stores/conversationStore";
import { voiceStore } from "../stores/voice";
import { SentenceChunker } from "../utils/sentenceChunker";

/** Everything the chat panel has to tell the loop about its own state. */
export interface VoiceAgentDeps {
	/** Session the turn should be sent to. */
	sessionId: () => string | null;
	/** "assisted" or "autonomous" — decides which store action runs. */
	autonomy: () => string;
	/** Per-turn model/effort overrides from the chat header. */
	turnOptions: () => TurnOptions;
}

/**
 * How long to wait for an in-flight turn to finish before dropping a new
 * utterance. Speaking over a reply normally cancels it (barge-in), so this only
 * covers the window where transcription finished first.
 */
const BUSY_WAIT_MS = 4000;

/**
 * Hands-free voice conversation.
 *
 * Rust owns the microphone, turn detection and transcription and emits
 * `voice-utterance`; this side decides what to do with the text, and turns the
 * reply back into speech sentence by sentence as it streams.
 */
export function useVoiceAgent(deps: VoiceAgentDeps) {
	const [active, setActive] = createSignal(false);
	const chunker = new SentenceChunker();

	const busy = () =>
		deps.autonomy() === "autonomous"
			? ["running", "paused"].includes(conversationStore.agentState())
			: conversationStore.isStreaming();

	const waitForIdle = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (busy() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return !busy();
	};

	/** Stop speaking and abandon the turn in progress. */
	const bargeIn = () => {
		chunker.reset();
		voiceStore.cancelSpeech();
		if (!busy()) return;
		if (deps.autonomy() === "autonomous") {
			const sid = deps.sessionId();
			if (sid) void conversationStore.cancelAgent(sid);
		} else {
			void conversationStore.cancelStream();
		}
	};

	const sendUtterance = async (text: string) => {
		if (!active()) return;
		const idle = await waitForIdle(BUSY_WAIT_MS);
		if (!idle || !active()) {
			// Length only — transcripts never reach the log.
			appLogger.warn("voice", `Dropped a ${text.length}-char utterance; chat still busy`);
			return;
		}
		const sid = deps.sessionId();
		voiceStore.setAgentState("thinking");
		chunker.reset();
		if (deps.autonomy() === "autonomous") {
			if (sid) {
				conversationStore.startAgent(sid, text, conversationStore.unrestricted(), deps.turnOptions());
			}
		} else {
			void conversationStore.sendMessage(text, sid, deps.turnOptions());
		}
	};

	// --- Rust -> here -----------------------------------------------------

	const unlistenUtterance = listen<{ text: string }>("voice-utterance", (event) => {
		const text = event.payload.text.trim();
		if (text) void sendUtterance(text);
	});

	// Only meaningful with barge-in enabled; in half-duplex mode Rust suppresses
	// the microphone while speaking, so this never fires mid-reply.
	const unlistenSpeechStart = listen("voice-speech-start", () => {
		if (active()) bargeIn();
	});

	// --- Reply -> speech --------------------------------------------------

	const stopObserving = conversationStore.observeReply({
		onDelta: (text) => {
			if (!active()) return;
			voiceStore.setAgentState("speaking");
			for (const sentence of chunker.feed(text)) voiceStore.speak(sentence);
		},
		onTurnEnd: () => {
			if (!active()) {
				chunker.reset();
				return;
			}
			const rest = chunker.flush();
			if (rest) voiceStore.speak(rest);
			// Not "listening" yet — the reply text is complete but its audio is
			// still queued. The status poll flips it back once the speaker
			// actually goes quiet.
		},
	});

	// --- Control ----------------------------------------------------------

	const start = async () => {
		if (active()) return;
		chunker.reset();
		try {
			await voiceStore.startSession();
			setActive(true);
		} catch {
			// startSession already recorded the reason in voiceStore.state.error.
			setActive(false);
		}
	};

	const stop = async () => {
		setActive(false);
		chunker.reset();
		voiceStore.cancelSpeech();
		await voiceStore.stopSession();
	};

	const toggle = () => {
		if (active()) void stop();
		else void start();
	};

	// The microphone is a process-wide singleton, so an abandoned session would
	// block dictation and the next voice session from ever starting.
	onCleanup(() => {
		void Promise.resolve(unlistenUtterance).then((un) => un?.());
		void Promise.resolve(unlistenSpeechStart).then((un) => un?.());
		stopObserving();
		if (active()) void stop();
	});

	return { active, start, stop, toggle, bargeIn };
}
