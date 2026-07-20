import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";
import { isTauri } from "../transport";
import { appLogger } from "./appLogger";
import { conversationStore } from "./conversationStore";
import { terminalsStore } from "./terminals";

/**
 * Voice agent — hands-free conversational control of the IDE.
 *
 * Ported from useVoiceAgent.js in ksg98/groq_local_stt: Silero VAD (webview)
 * detects utterances → WAV → Rust STT (`voice_transcribe_wav`, same provider
 * pipeline as dictation) → transcript auto-sends into the AI conversation with
 * `voiceMode: true`, which makes Rust speak the streamed reply (kokoro sidecar
 * or cloud TTS) with barge-in. Desktop only.
 */

/** Mirrors VoiceAgentConfig in src-tauri/src/voice_agent/commands.rs */
interface VoiceAgentConfig {
	enabled: boolean;
	tts_provider: string;
	kokoro_voice: string;
	kokoro_speed: number;
	tts_model_groq: string;
	tts_voice_groq: string;
	tts_model_openai: string;
	tts_voice_openai: string;
	hands_free: boolean;
	mute_tts: boolean;
	output_device: string | null;
}

interface TtsStatusPayload {
	state: string;
	detail?: string;
	message?: string;
}

interface VoiceTtsStatus {
	provider: string;
	kokoro_supported: boolean;
	uv_found: boolean;
	sidecar: TtsStatusPayload;
	groq_key_exists: boolean;
	openai_key_exists: boolean;
	speaking: boolean;
}

interface TranscribeResponse {
	text: string;
	skip_reason: string | null;
	duration_s: number;
}

export type VoiceUiState = "idle" | "starting" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

/** Pill/indicator colors per voice UI state (inline styles — dynamic CSS-module
 * class lookups would be purged by the build). */
export const VOICE_STATE_COLORS: Record<VoiceUiState, string> = {
	idle: "#9ca3af",
	starting: "#9ca3af",
	listening: "#34d399",
	transcribing: "#c084fc",
	thinking: "#fbbf24",
	speaking: "#60a5fa",
	error: "#f87171",
};

interface VoiceAgentStoreState {
	/** Voice session running (VAD live). */
	active: boolean;
	starting: boolean;
	speaking: boolean;
	transcribing: boolean;
	micMuted: boolean;
	error: string | null;
	sidecar: TtsStatusPayload | null;
	// Config mirror (snake_case fields live only in the transport shape)
	ttsProvider: string;
	kokoroVoice: string;
	kokoroSpeed: number;
	ttsModelGroq: string;
	ttsVoiceGroq: string;
	ttsModelOpenai: string;
	ttsVoiceOpenai: string;
	handsFree: boolean;
	muteTts: boolean;
	outputDevice: string | null;
	// Settings support
	ttsModels: string[];
	fetchingTtsModels: boolean;
	ttsModelsError: string | null;
	kokoroSupported: boolean;
	uvFound: boolean;
	groqKeyExists: boolean;
	openaiKeyExists: boolean;
}

/** MicVAD instance type (loaded lazily — the wasm bundle is heavy). */
type MicVadInstance = {
	start: () => void;
	pause: () => void;
	destroy: () => Promise<void> | void;
};

function base64FromArrayBuffer(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

function createVoiceAgentStore() {
	const [state, setState] = createStore<VoiceAgentStoreState>({
		active: false,
		starting: false,
		speaking: false,
		transcribing: false,
		micMuted: false,
		error: null,
		sidecar: null,
		ttsProvider: "kokoro",
		kokoroVoice: "af_heart",
		kokoroSpeed: 1.0,
		ttsModelGroq: "",
		ttsVoiceGroq: "",
		ttsModelOpenai: "",
		ttsVoiceOpenai: "",
		handsFree: true,
		muteTts: false,
		outputDevice: null,
		ttsModels: [],
		fetchingTtsModels: false,
		ttsModelsError: null,
		kokoroSupported: false,
		uvFound: false,
		groqKeyExists: false,
		openaiKeyExists: false,
	});

	let vad: MicVadInstance | null = null;
	let listenersReady = false;

	/** Session ID of the currently active terminal tab. */
	const activeSessionId = (): string | null => {
		const id = terminalsStore.state.activeId;
		return id ? (terminalsStore.get(id)?.sessionId ?? null) : null;
	};

	const isThinking = (): boolean => conversationStore.isStreaming() || conversationStore.agentState() === "running";

	/** Derived pill state — reads reactive sources, safe to call from JSX. */
	const uiState = (): VoiceUiState => {
		if (!state.active) return "idle";
		if (state.error) return "error";
		if (state.speaking) return "speaking";
		if (state.transcribing) return "transcribing";
		if (state.starting) return "starting";
		if (isThinking()) return "thinking";
		return "listening";
	};

	async function registerListeners(): Promise<void> {
		if (listenersReady || !isTauri()) return;
		listenersReady = true;
		await listen<{ speaking: boolean }>("voice-speaking-changed", (event) => {
			setState("speaking", event.payload.speaking);
		});
		await listen<TtsStatusPayload>("voice-tts-status", (event) => {
			setState("sidecar", event.payload);
			if (event.payload.state === "error" && event.payload.message) {
				setState("error", event.payload.message);
			}
		});
		await listen<{ message: string }>("voice-tts-error", (event) => {
			appLogger.warn("voice-agent", "TTS error", { message: event.payload.message });
		});
	}

	async function bargeIn(): Promise<void> {
		if (!state.speaking && !isThinking()) return;
		try {
			await invoke("voice_agent_interrupt", { sessionId: activeSessionId() });
		} catch (err) {
			appLogger.warn("voice-agent", "interrupt failed", { error: String(err) });
		}
	}

	/** Wait (≤timeoutMs) for the conversation to go idle before auto-sending. */
	async function waitForIdle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (isThinking() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return !isThinking();
	}

	async function handleUtterance(audio: Float32Array): Promise<void> {
		if (!state.active) return;
		setState("transcribing", true);
		try {
			const { utils } = await import("@ricky0123/vad-web");
			// 16 kHz mono int16 WAV (format 1 = PCM)
			const wav = utils.encodeWAV(audio, 1, 16000, 1, 16);
			const result = await invoke<TranscribeResponse>("voice_transcribe_wav", {
				wavBase64: base64FromArrayBuffer(wav),
			});
			const text = result?.text?.trim();
			if (text && state.active) {
				const idle = await waitForIdle(4000);
				if (idle && state.active) {
					sendToConversation(text);
				} else if (state.active) {
					appLogger.warn("voice-agent", "conversation still busy — utterance dropped", { text });
				}
			}
		} catch (err) {
			appLogger.error("voice-agent", "transcription failed", err);
			setState("error", String(err));
		} finally {
			setState("transcribing", false);
		}
	}

	/** Route a transcript into the AI conversation with the voice persona. */
	function sendToConversation(text: string): void {
		const sid = activeSessionId();
		if (!sid) {
			setState("error", "No terminal attached — focus a terminal first");
			return;
		}
		setState("error", null);
		void conversationStore.sendMessage(text, sid, { voiceMode: true });
	}

	async function start(): Promise<void> {
		if (state.active || state.starting || !isTauri()) return;
		setState({ starting: true, error: null });
		try {
			await registerListeners();

			const perm = await invoke<string>("check_microphone_permission");
			if (perm === "denied" || perm === "restricted") {
				void invoke("open_microphone_settings").catch(() => {});
				throw new Error(
					"Microphone access is blocked. Enable it in System Settings > Privacy & Security > Microphone.",
				);
			}

			// Warm the TTS engine in the background (kokoro model load can take a
			// while on first run; cloud providers are ready immediately).
			if (!state.muteTts && state.ttsProvider === "kokoro") {
				void invoke("voice_kokoro_preload").catch((err) => {
					appLogger.warn("voice-agent", "kokoro preload failed — falling back to cloud requires Settings", {
						error: String(err),
					});
				});
			}

			const { MicVAD } = await import("@ricky0123/vad-web");
			// Absolute origin-prefixed base (same as the groq_local_stt reference):
			// ort resolves these inside worker/blob contexts where root-relative
			// paths fail with "Importing a module script failed".
			const vadBase = `${window.location.origin}/vad/`;
			const instance = await MicVAD.new({
				model: "v5",
				baseAssetPath: vadBase,
				onnxWASMBasePath: vadBase,
				getStream: () =>
					navigator.mediaDevices.getUserMedia({
						audio: {
							channelCount: 1,
							// Echo cancellation is what makes barge-in work over speakers —
							// without it the VAD hears the TTS output as speech.
							echoCancellation: true,
							noiseSuppression: true,
							autoGainControl: true,
						},
					}),
				positiveSpeechThreshold: 0.6,
				negativeSpeechThreshold: 0.35,
				redemptionMs: 800,
				preSpeechPadMs: 300,
				minSpeechMs: 250,
				onSpeechStart: () => {
					if (state.active) void bargeIn();
				},
				onSpeechEnd: (audio: Float32Array) => {
					void handleUtterance(audio);
				},
			});
			vad = instance;
			setState({ active: true, micMuted: false });
			if (state.handsFree) {
				instance.start();
			}
			void voiceAgentStore.saveConfig({ enabled: true });
		} catch (err) {
			appLogger.error("voice-agent", "failed to start", err);
			setState("error", String(err instanceof Error ? err.message : err));
			await stop(false);
		} finally {
			setState("starting", false);
		}
	}

	async function stop(persist = true): Promise<void> {
		const instance = vad;
		vad = null;
		if (instance) {
			try {
				await instance.destroy();
			} catch {
				// already gone
			}
		}
		try {
			await invoke("voice_agent_interrupt", { sessionId: null });
		} catch {
			// backend unavailable (e.g. app shutting down)
		}
		setState({ active: false, micMuted: false, transcribing: false, speaking: false });
		if (persist) {
			void voiceAgentStore.saveConfig({ enabled: false });
		}
		// Keep the kokoro sidecar warm across toggles; it dies on app quit.
	}

	const voiceAgentStore = {
		state,
		uiState,
		activeSessionId,
		start,
		stop,
		async toggle(): Promise<void> {
			if (state.active) {
				await stop();
			} else {
				await start();
			}
		},

		/** Route a final push-to-talk transcript into the conversation. */
		sendTranscript(text: string): void {
			sendToConversation(text);
		},

		/** Pause/resume the VAD without ending the session. */
		toggleMicMute(): void {
			if (!vad) return;
			const next = !state.micMuted;
			setState("micMuted", next);
			if (next) {
				vad.pause();
			} else {
				vad.start();
			}
		},

		/** Text-only replies: muting silences immediately. */
		async toggleTtsMute(): Promise<void> {
			const next = !state.muteTts;
			await voiceAgentStore.saveConfig({ mute_tts: next });
			if (next) {
				try {
					await invoke("voice_agent_interrupt", { sessionId: null });
				} catch {
					// non-fatal
				}
			}
		},

		clearError(): void {
			setState("error", null);
		},

		async refreshConfig(): Promise<void> {
			if (!isTauri()) return;
			try {
				const config = await invoke<VoiceAgentConfig>("get_voice_agent_config");
				setState({
					ttsProvider: config.tts_provider ?? "kokoro",
					kokoroVoice: config.kokoro_voice ?? "af_heart",
					kokoroSpeed: config.kokoro_speed ?? 1.0,
					ttsModelGroq: config.tts_model_groq ?? "",
					ttsVoiceGroq: config.tts_voice_groq ?? "",
					ttsModelOpenai: config.tts_model_openai ?? "",
					ttsVoiceOpenai: config.tts_voice_openai ?? "",
					handsFree: config.hands_free ?? true,
					muteTts: config.mute_tts ?? false,
					outputDevice: config.output_device ?? null,
				});
			} catch (err) {
				appLogger.error("voice-agent", "failed to load config", err);
			}
		},

		async saveConfig(partial: Partial<VoiceAgentConfig>): Promise<void> {
			if (!isTauri()) return;
			const config: VoiceAgentConfig = {
				enabled: partial.enabled ?? state.active,
				tts_provider: partial.tts_provider ?? state.ttsProvider,
				kokoro_voice: partial.kokoro_voice ?? state.kokoroVoice,
				kokoro_speed: partial.kokoro_speed ?? state.kokoroSpeed,
				tts_model_groq: partial.tts_model_groq ?? state.ttsModelGroq,
				tts_voice_groq: partial.tts_voice_groq ?? state.ttsVoiceGroq,
				tts_model_openai: partial.tts_model_openai ?? state.ttsModelOpenai,
				tts_voice_openai: partial.tts_voice_openai ?? state.ttsVoiceOpenai,
				hands_free: partial.hands_free ?? state.handsFree,
				mute_tts: partial.mute_tts ?? state.muteTts,
				output_device: partial.output_device !== undefined ? partial.output_device : state.outputDevice,
			};
			try {
				await invoke("set_voice_agent_config", { config });
				const update: Partial<VoiceAgentStoreState> = {};
				if (partial.tts_provider !== undefined) update.ttsProvider = partial.tts_provider;
				if (partial.kokoro_voice !== undefined) update.kokoroVoice = partial.kokoro_voice;
				if (partial.kokoro_speed !== undefined) update.kokoroSpeed = partial.kokoro_speed;
				if (partial.tts_model_groq !== undefined) update.ttsModelGroq = partial.tts_model_groq;
				if (partial.tts_voice_groq !== undefined) update.ttsVoiceGroq = partial.tts_voice_groq;
				if (partial.tts_model_openai !== undefined) update.ttsModelOpenai = partial.tts_model_openai;
				if (partial.tts_voice_openai !== undefined) update.ttsVoiceOpenai = partial.tts_voice_openai;
				if (partial.hands_free !== undefined) update.handsFree = partial.hands_free;
				if (partial.mute_tts !== undefined) update.muteTts = partial.mute_tts;
				if (partial.output_device !== undefined) update.outputDevice = partial.output_device;
				setState(update);
			} catch (err) {
				appLogger.error("voice-agent", "failed to save config", err);
			}
		},

		async refreshTtsStatus(): Promise<void> {
			if (!isTauri()) return;
			try {
				const status = await invoke<VoiceTtsStatus>("voice_tts_status");
				setState({
					kokoroSupported: status.kokoro_supported,
					uvFound: status.uv_found,
					sidecar: status.sidecar,
					groqKeyExists: status.groq_key_exists,
					openaiKeyExists: status.openai_key_exists,
					speaking: status.speaking,
				});
			} catch (err) {
				appLogger.error("voice-agent", "failed to load TTS status", err);
			}
		},

		async fetchTtsModels(provider: string): Promise<void> {
			setState({ fetchingTtsModels: true, ttsModelsError: null });
			try {
				const models = await invoke<string[]>("voice_fetch_tts_models", { provider });
				setState({ ttsModels: models, fetchingTtsModels: false });
			} catch (err) {
				setState({ ttsModels: [], fetchingTtsModels: false, ttsModelsError: String(err) });
			}
		},

		async kokoroPreload(): Promise<void> {
			try {
				await invoke("voice_kokoro_preload");
			} catch (err) {
				setState("error", String(err));
			}
		},

		async kokoroUnload(): Promise<void> {
			if (state.active) return;
			try {
				await invoke("voice_kokoro_unload");
				await voiceAgentStore.refreshTtsStatus();
			} catch (err) {
				appLogger.warn("voice-agent", "kokoro unload failed", { error: String(err) });
			}
		},

		async speakTest(text: string): Promise<void> {
			try {
				await invoke("voice_speak", { text });
			} catch (err) {
				setState("error", String(err));
			}
		},

		/** App-mount init: load config + provider status, register listeners. */
		async init(): Promise<void> {
			if (!isTauri()) return;
			await registerListeners();
			await voiceAgentStore.refreshConfig();
			await voiceAgentStore.refreshTtsStatus();
		},
	};

	return voiceAgentStore;
}

export const voiceAgentStore = createVoiceAgentStore();
