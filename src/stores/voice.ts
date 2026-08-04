import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";
import { isTauri } from "../transport";
import { appLogger } from "./appLogger";

/** Voice-agent config persisted to ~/.tuicommander/voice-config.json */
export interface VoiceConfig {
	model: string;
	voice: string;
	speed: number;
	barge_in: boolean;
	output_device: string | null;
}

/** A downloadable Kokoro graph. */
export interface VoiceModelInfo {
	name: string;
	display_name: string;
	size_hint_mb: number;
	downloaded: boolean;
	actual_size_mb: number;
}

/** One selectable voice and whether its style table is on disk. */
export interface VoiceInfo {
	id: string;
	display_name: string;
	downloaded: boolean;
}

interface VoiceStatus {
	engine_state: string;
	loaded_model: string | null;
	session_active: boolean;
	speaking: boolean;
	audio_level: number;
}

interface AudioOutputDevice {
	name: string;
	is_default: boolean;
}

/**
 * What the agent is doing right now. `thinking` and `speaking` are driven from
 * the frontend (the chat stream and the TTS queue), the rest from Rust.
 */
export type VoiceAgentState = "idle" | "starting" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

interface VoiceStoreState {
	config: VoiceConfig;
	models: VoiceModelInfo[];
	voices: VoiceInfo[];
	outputDevices: AudioOutputDevice[];
	engineState: string;
	loadedModel: string | null;
	sessionActive: boolean;
	agentState: VoiceAgentState;
	audioLevel: number;
	/** Which asset id is downloading, so only its row shows a bar. */
	downloading: string | null;
	downloadPercent: number;
	loadingEngine: boolean;
	error: string;
}

const DEFAULT_CONFIG: VoiceConfig = {
	model: "q8f16",
	voice: "af_heart",
	speed: 1.0,
	// Mirrors the Rust default; echo cancellation is what makes it safe.
	barge_in: true,
	output_device: null,
};

function normalizeLevel(value: number | undefined): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value as number)) : 0;
}

function createVoiceStore() {
	const [state, setState] = createStore<VoiceStoreState>({
		config: { ...DEFAULT_CONFIG },
		models: [],
		voices: [],
		outputDevices: [],
		engineState: "stopped",
		loadedModel: null,
		sessionActive: false,
		agentState: "idle",
		audioLevel: 0,
		downloading: null,
		downloadPercent: 0,
		loadingEngine: false,
		error: "",
	});

	listen<{ downloaded: number; total: number; percent: number }>("voice-download-progress", (event) =>
		setState("downloadPercent", event.payload.percent),
	);

	listen<{ state: VoiceAgentState }>("voice-state", (event) => {
		// Rust owns listening/transcribing; it must not clobber the frontend's
		// thinking/speaking, which it cannot observe.
		setState("agentState", event.payload.state);
	});

	listen<{ message: string }>("voice-error", (event) => {
		setState("error", event.payload.message);
		appLogger.error("voice", "Voice session error", event.payload.message);
	});

	// The mic meter needs a faster cadence than status polling gives us, and
	// only while a session is live.
	let levelTimer: ReturnType<typeof setInterval> | null = null;
	const stopLevelPolling = () => {
		if (levelTimer) clearInterval(levelTimer);
		levelTimer = null;
		setState("audioLevel", 0);
	};
	const startLevelPolling = () => {
		stopLevelPolling();
		levelTimer = setInterval(() => {
			void invoke<VoiceStatus>("voice_status")
				.then((status) => {
					setState("audioLevel", normalizeLevel(status.audio_level));
					// Rust knows when the speaker actually goes quiet; the reply
					// stream finishes well before the audio queue drains, so
					// without this the label would read "Listening…" over the
					// tail of the agent's own sentence.
					if (status.speaking) {
						setState("agentState", "speaking");
					} else if (state.agentState === "speaking") {
						setState("agentState", "listening");
					}
				})
				.catch(() => stopLevelPolling());
		}, 75);
	};

	const actions = {
		async refreshConfig(): Promise<void> {
			if (!isTauri()) return;
			try {
				setState("config", await invoke<VoiceConfig>("voice_get_config"));
			} catch (err) {
				appLogger.error("voice", "Failed to load voice config", err);
			}
		},

		/** Persist a partial config change; Rust drops a stale engine if needed. */
		async saveConfig(partial: Partial<VoiceConfig>): Promise<void> {
			const config = { ...state.config, ...partial };
			try {
				await invoke("voice_set_config", { config });
				setState("config", config);
				// Changing the model or voice invalidates what is resident.
				if (partial.model !== undefined || partial.voice !== undefined) {
					await actions.refreshStatus();
				}
			} catch (err) {
				setState("error", String(err));
				appLogger.error("voice", "Failed to save voice config", err);
			}
		},

		async refreshStatus(): Promise<void> {
			if (!isTauri()) return;
			try {
				const status = await invoke<VoiceStatus>("voice_status");
				setState({
					engineState: status.engine_state,
					loadedModel: status.loaded_model,
					sessionActive: status.session_active,
				});
			} catch (err) {
				appLogger.error("voice", "Failed to get voice status", err);
			}
		},

		async refreshModels(): Promise<void> {
			if (!isTauri()) return;
			try {
				const [models, voices] = await Promise.all([
					invoke<VoiceModelInfo[]>("voice_model_info"),
					invoke<VoiceInfo[]>("voice_list_voices"),
				]);
				setState({ models, voices });
			} catch (err) {
				appLogger.error("voice", "Failed to list voice models", err);
			}
		},

		async refreshOutputDevices(): Promise<void> {
			if (!isTauri()) return;
			try {
				setState("outputDevices", await invoke<AudioOutputDevice[]>("voice_list_output_devices"));
			} catch (err) {
				appLogger.error("voice", "Failed to list output devices", err);
			}
		},

		async downloadModel(name: string): Promise<void> {
			setState({ downloading: name, downloadPercent: 0, error: "" });
			try {
				await invoke<string>("voice_download_model", { modelName: name });
				await actions.refreshModels();
			} catch (err) {
				setState("error", String(err));
				appLogger.error("voice", "Voice model download failed", err);
			} finally {
				setState("downloading", null);
			}
		},

		async downloadVoice(id: string): Promise<void> {
			setState({ downloading: id, downloadPercent: 0, error: "" });
			try {
				await invoke<string>("voice_download_voice", { voiceId: id });
				await actions.refreshModels();
			} catch (err) {
				setState("error", String(err));
				appLogger.error("voice", "Voice download failed", err);
			} finally {
				setState("downloading", null);
			}
		},

		async deleteModel(name: string): Promise<void> {
			try {
				await invoke("voice_delete_model", { modelName: name });
				await Promise.all([actions.refreshModels(), actions.refreshStatus()]);
			} catch (err) {
				setState("error", String(err));
			}
		},

		async deleteVoice(id: string): Promise<void> {
			try {
				await invoke("voice_delete_voice", { voiceId: id });
				await Promise.all([actions.refreshModels(), actions.refreshStatus()]);
			} catch (err) {
				setState("error", String(err));
			}
		},

		/** Preload the engine so the first spoken sentence isn't delayed by it. */
		async loadEngine(): Promise<void> {
			setState({ loadingEngine: true, error: "" });
			try {
				await invoke("voice_load_engine");
				await actions.refreshStatus();
			} catch (err) {
				setState("error", String(err));
				appLogger.error("voice", "Failed to load voice engine", err);
			} finally {
				setState("loadingEngine", false);
			}
		},

		async unloadEngine(): Promise<void> {
			try {
				await invoke("voice_unload_engine");
				await actions.refreshStatus();
			} catch (err) {
				setState("error", String(err));
			}
		},

		/** Begin a hands-free session. Throws so the caller can surface why. */
		async startSession(): Promise<void> {
			setState({ error: "", agentState: "starting" });
			try {
				await invoke("voice_start");
				setState({ sessionActive: true, agentState: "listening" });
				startLevelPolling();
				await actions.refreshStatus();
			} catch (err) {
				setState({ agentState: "idle", error: String(err) });
				if (String(err).includes("microphone_denied")) {
					invoke("open_microphone_settings").catch(() => {});
				}
				throw err;
			}
		},

		async stopSession(): Promise<void> {
			stopLevelPolling();
			setState({ sessionActive: false, agentState: "idle" });
			try {
				await invoke("voice_stop");
			} catch (err) {
				appLogger.error("voice", "Failed to stop voice session", err);
			}
		},

		/** Speak one sentence. Failures are logged, never surfaced mid-reply. */
		speak(text: string): void {
			void invoke("voice_speak", { text }).catch((err) => {
				appLogger.error("voice", "Failed to speak", err);
			});
		},

		cancelSpeech(): void {
			void invoke("voice_cancel_speech").catch(() => {});
		},

		setAgentState(next: VoiceAgentState): void {
			setState("agentState", next);
		},

		clearError(): void {
			setState("error", "");
		},
	};

	return { state, ...actions };
}

export const voiceStore = createVoiceStore();
