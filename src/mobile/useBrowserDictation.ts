import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { t } from "../i18n";
import { appLogger } from "../stores/appLogger";
import { toastsStore } from "../stores/toasts";
import { rpc } from "../transport";
import { randomId } from "../utils/randomId";
import { holdScreenAwake } from "../utils/screenWakeLock";

interface RecognitionResult {
	isFinal: boolean;
	readonly [index: number]: { transcript: string };
}

interface BrowserRecognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

type RecognitionConstructor = new () => BrowserRecognition;

/** Plain words for the Web Speech error codes; an unknown code is shown as is. */
function failureText(code: string): string {
	switch (code) {
		case "not-allowed":
			return t("mobile.dictation.error.notAllowed", "Microphone or speech recognition permission denied");
		case "service-not-allowed":
			return t("mobile.dictation.error.serviceNotAllowed", "Speech recognition is not allowed on this device");
		case "no-speech":
			return t("mobile.dictation.error.noSpeech", "No speech detected");
		case "audio-capture":
			// DEFERRED (2026-10-27) — physical iPad capture attribution needs a device replay;
			// this browser code does not distinguish a missing, busy or interrupted microphone.
			return t("mobile.dictation.error.audioCapture", "No microphone found, or it is in use");
		case "network":
			return t("mobile.dictation.error.network", "Speech service unavailable (network)");
		default:
			return code;
	}
}

/** Browser input interaction only; server hands-free remains a separate conversation. */
export function useBrowserDictation(options: {
	/** Desktop composers must not initialize browser speech or fetch its config. */
	enabled?: boolean;
	blocked: Accessor<boolean>;
	/** Owner identity captured once per take; an unbound ACP draft has no session yet. */
	sessionId: Accessor<string | null>;
	getDraft: Accessor<string>;
	/** Capture an insertion range for this take; omitted composers keep tail insertion. */
	getSelection?: Accessor<{ start: number; end: number }>;
	setDraft: (text: string) => void;
	onRecording?: (recording: boolean) => void;
}) {
	const browser = window as Window & {
		SpeechRecognition?: RecognitionConstructor;
		webkitSpeechRecognition?: RecognitionConstructor;
	};
	const Constructor =
		options.enabled === false ? undefined : (browser.SpeechRecognition ?? browser.webkitSpeechRecognition);
	const [recording, setRecording] = createSignal(false);
	let recognition: BrowserRecognition | null = null;
	let discarding = false;
	let language = navigator.language;
	let renderedSpeech = "";
	let take: {
		id: string;
		sessionId: string | null;
		firstResult: boolean;
		errorLogged: boolean;
		sequence: number;
	} | null = null;

	// At most six content-free records per take, never one per hypothesis.
	function trace(event: string, code?: string) {
		if (!take) return;
		appLogger.debug("dictation", `Browser dictation lifecycle: ${event} [${take.id}]`, {
			event,
			sequence: ++take.sequence,
			sessionId: take.sessionId,
			takeId: take.id,
			recording: !!recognition,
			discarding,
			code,
		});
	}

	function traceError(code: string) {
		if (!take || take.errorLogged) return;
		take.errorLogged = true;
		trace("error", code);
	}

	if (Constructor) {
		void rpc<{ language?: string }>("get_dictation_config")
			.then((config) => {
				if (config?.language && config.language !== "auto") language = config.language;
			})
			.catch((error) => appLogger.info("dictation", "Browser dictation uses browser language", error));
	}

	let releaseScreen: (() => void) | null = null;

	function markRecording(active: boolean) {
		// Every start, end, error and cancel passes here, so the lock cannot outlive the recording.
		if (active) releaseScreen ??= holdScreenAwake();
		else {
			releaseScreen?.();
			releaseScreen = null;
		}
		setRecording(active);
		options.onRecording?.(active);
	}

	function fail(code: string, cause?: unknown) {
		// The code is in the message: the logger coalesces equal messages and would drop the
		// data of a second failure with another code before it reaches the server log.
		appLogger.warn("dictation", `Browser dictation failed: ${code}`, {
			code,
			recording: !!recognition,
			discarding,
			partialChars: renderedSpeech.length,
			language,
			cause: cause === undefined ? undefined : String(cause),
		});
		toastsStore.add(t("mobile.dictation.error", "Dictation failed"), failureText(code), "error", true);
	}

	/** A thrown start/stop failure: its name is the code, the full error the cause. */
	function failWith(error: unknown) {
		const code = error instanceof Error ? error.name : "unknown";
		traceError(code);
		fail(code, error);
	}

	function release() {
		if (recognition) recognition.onresult = recognition.onerror = recognition.onend = null;
		recognition = null;
		markRecording(false);
		trace("ownership-release");
		take = null;
	}

	function cancel() {
		if (!recognition || discarding) return;
		discarding = true;
		trace("abort-requested");
		// abort() is asynchronous: keep the service and microphone claim until end.
		try {
			recognition.abort();
		} catch (error) {
			failWith(error);
			release();
		}
	}

	createEffect(() => {
		if (options.blocked() && recognition) cancel();
	});
	onCleanup(cancel);

	function toggle() {
		if (recognition) {
			if (discarding) return;
			try {
				recognition.stop();
			} catch (error) {
				failWith(error);
				cancel();
			}
			return;
		}
		if (!Constructor || options.blocked()) return;
		try {
			take = {
				id: randomId("dictation-"),
				sessionId: options.sessionId(),
				firstResult: false,
				errorLogged: false,
				sequence: 0,
			};
			discarding = false;
			renderedSpeech = "";
			const selection = options.getSelection?.();
			const draftAtStart = selection ? options.getDraft() : "";
			const selectedDraft = selection
				? {
						prefix: draftAtStart.slice(0, selection.start),
						text: draftAtStart.slice(selection.start, selection.end),
						suffix: draftAtStart.slice(selection.end),
					}
				: null;
			const current = new Constructor();
			recognition = current;
			current.lang = language;
			current.continuous = true;
			current.interimResults = true;
			current.onresult = (event) => {
				if (recognition !== current) return;
				if (take && !take.firstResult) {
					take.firstResult = true;
					trace("first-result");
				}
				if (discarding) return;
				const speech = Array.from(event.results, (result) => result[0].transcript.trim())
					.join(" ")
					.trim();
				if (selectedDraft) {
					const { prefix, text, suffix } = selectedDraft;
					renderedSpeech = speech
						? `${prefix && !/\s$/.test(prefix) ? " " : ""}${speech}${suffix && !/^\s/.test(suffix) ? " " : ""}`
						: "";
					options.setDraft(prefix + (speech ? renderedSpeech : text) + suffix);
					return;
				}
				const draft = options.getDraft();
				// Replace the previous hypothesis only while it still owns the draft tail.
				// Manual composer edits cancel recognition before changing the draft.
				const base = renderedSpeech && draft.endsWith(renderedSpeech) ? draft.slice(0, -renderedSpeech.length) : draft;
				renderedSpeech = speech ? `${base && !/\s$/.test(base) ? " " : ""}${speech}` : "";
				options.setDraft(base + renderedSpeech);
			};
			current.onerror = (event) => {
				if (recognition !== current) return;
				traceError(event.error);
				if (discarding) return;
				// End a failed take through the same shutdown path as an edit/send.
				// Discarding alone would also prevent edit/send from requesting shutdown.
				fail(event.error);
				cancel();
			};
			current.onend = () => {
				if (recognition !== current) return;
				trace("end");
				release();
			};
			// Claim the microphone before start(), including the permission prompt.
			markRecording(true);
			trace("start");
			current.start();
		} catch (error) {
			// A synchronous start failure has no running service to emit end.
			failWith(error);
			release();
		}
	}

	return { available: !!Constructor, recording, toggle, cancel };
}
