import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";
import { isTauri } from "../transport";
import { appLogger } from "./appLogger";

/** Dictation config persisted to ~/.tuicommander/dictation-config.json */
interface DictationConfig {
	enabled: boolean;
	hotkey: string;
	language: string;
	model: string;
	device: string | null;
	long_press_ms: number;
	auto_send: boolean;
	rewrite_enabled: boolean;
	rewrite_base_url: string;
	rewrite_model: string;
	rewrite_effort: string | null;
	rewrite_system_prompt: string;
	stt_provider: string;
	stt_model_groq: string;
	stt_model_openai: string;
	stt_base_url: string;
	stt_model_custom: string;
}

/** Default rewrite system prompt — must match default_rewrite_system_prompt() in Rust */
export const DEFAULT_REWRITE_SYSTEM_PROMPT =
	"Rewrite the user's dictated text into a clear, well-structured prompt for an AI coding " +
	"assistant. Fix transcription errors, remove filler words and false starts, and preserve " +
	"the original intent and all technical details. Output only the rewritten text with no " +
	"preamble or explanation.";

/** Model advertised by the rewrite endpoint's /models route (from Rust backend) */
export interface RewriteModelInfo {
	id: string;
	supports_reasoning: boolean;
	effort_options: string[] | null;
	default_effort: string | null;
}

/** GPU/CPU backend reported by whisper after model load. */
export type DictationBackend = "cpu" | "gpu";

/** Model info from Rust backend */
export interface ModelInfo {
	name: string;
	display_name: string;
	size_hint_mb: number;
	downloaded: boolean;
	actual_size_mb: number;
}

/** Model status values from Rust backend */
type ModelStatus = "not_downloaded" | "downloaded" | "ready" | "not_configured";

/** Model status from Rust backend */
interface DictationStatus {
	model_status: ModelStatus;
	model_name: string;
	model_size_mb: number;
	recording: boolean;
	processing: boolean;
}

/** Transcription response from Rust backend */
interface TranscribeResponse {
	text: string;
	skip_reason: string | null;
	duration_s: number;
}

/** Audio device from Rust backend */
interface AudioDevice {
	name: string;
	is_default: boolean;
}

/** Download progress event payload */
interface DownloadProgress {
	downloaded: number;
	total: number;
	percent: number;
}

/** Supported languages for Whisper */
export const WHISPER_LANGUAGES: Record<string, string> = {
	auto: "Auto-detect",
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
	ja: "Japanese",
	zh: "Chinese",
	ko: "Korean",
	ru: "Russian",
};

/** Store state */
interface DictationStoreState {
	enabled: boolean;
	hotkey: string;
	language: string;
	selectedModel: string;
	selectedDevice: string | null;
	models: ModelInfo[];
	modelStatus: ModelStatus;
	modelName: string;
	modelSizeMb: number;
	recording: boolean;
	processing: boolean;
	loading: boolean; // Model is being loaded into memory on first use
	downloading: boolean;
	downloadPercent: number;
	corrections: Record<string, string>;
	devices: AudioDevice[];
	longPressMs: number;
	autoSend: boolean;
	capturingHotkey: boolean;
	partialText: string;
	backendInfo: DictationBackend | null;
	rewriteEnabled: boolean;
	rewriteBaseUrl: string;
	rewriteModel: string;
	rewriteEffort: string | null;
	rewriteSystemPrompt: string;
	rewriteModels: RewriteModelInfo[];
	fetchingRewriteModels: boolean;
	rewriteModelsError: string | null;
	rewriteKeyExists: boolean;
	rewriting: boolean;
	sttProvider: string;
	sttModelGroq: string;
	sttModelOpenai: string;
	sttBaseUrl: string;
	sttModelCustom: string;
	sttModels: string[];
	fetchingSttModels: boolean;
	sttModelsError: string | null;
	sttKeyExists: Record<string, boolean>;
}

function createDictationStore() {
	const [state, setState] = createStore<DictationStoreState>({
		enabled: false,
		hotkey: "F5",
		language: "auto",
		selectedModel: "large-v3-turbo",
		selectedDevice: null,
		models: [],
		modelStatus: "not_downloaded",
		modelName: "",
		modelSizeMb: 0,
		recording: false,
		processing: false,
		loading: false,
		downloading: false,
		downloadPercent: 0,
		corrections: {},
		devices: [],
		longPressMs: 400,
		autoSend: false,
		capturingHotkey: false,
		partialText: "",
		backendInfo: null,
		rewriteEnabled: false,
		rewriteBaseUrl: "",
		rewriteModel: "",
		rewriteEffort: null,
		rewriteSystemPrompt: DEFAULT_REWRITE_SYSTEM_PROMPT,
		rewriteModels: [],
		fetchingRewriteModels: false,
		rewriteModelsError: null,
		rewriteKeyExists: false,
		rewriting: false,
		sttProvider: "local",
		sttModelGroq: "",
		sttModelOpenai: "",
		sttBaseUrl: "",
		sttModelCustom: "",
		sttModels: [],
		fetchingSttModels: false,
		sttModelsError: null,
		sttKeyExists: {},
	});

	// Listen for download progress events from Rust
	listen<DownloadProgress>("dictation-download-progress", (event) => {
		setState("downloadPercent", event.payload.percent);
	});

	// Listen for streaming partial transcription results
	listen<string>("dictation-partial", (event) => {
		setState("partialText", event.payload);
	});

	// Listen for backend info (gpu/cpu) after model load
	listen<{ backend: DictationBackend }>("dictation-backend-info", (event) => {
		setState("backendInfo", event.payload.backend);
	});

	const actions = {
		/** Load config from Rust backend (file-based) */
		async refreshConfig(): Promise<void> {
			if (!isTauri()) return;
			try {
				const config = await invoke<DictationConfig>("get_dictation_config");
				setState({
					enabled: config.enabled,
					hotkey: config.hotkey,
					language: config.language,
					selectedModel: config.model ?? "large-v3-turbo",
					selectedDevice: config.device ?? null,
					longPressMs: config.long_press_ms ?? 400,
					autoSend: config.auto_send ?? false,
					rewriteEnabled: config.rewrite_enabled ?? false,
					rewriteBaseUrl: config.rewrite_base_url ?? "",
					rewriteModel: config.rewrite_model ?? "",
					rewriteEffort: config.rewrite_effort ?? null,
					rewriteSystemPrompt: config.rewrite_system_prompt ?? DEFAULT_REWRITE_SYSTEM_PROMPT,
					sttProvider: config.stt_provider ?? "local",
					sttModelGroq: config.stt_model_groq ?? "",
					sttModelOpenai: config.stt_model_openai ?? "",
					sttBaseUrl: config.stt_base_url ?? "",
					sttModelCustom: config.stt_model_custom ?? "",
				});
			} catch (err) {
				appLogger.error("dictation", "Failed to get dictation config", err);
			}
		},

		/** Save a single config field to disk via Rust */
		async saveConfig(partial: Partial<DictationConfig>): Promise<void> {
			const config: DictationConfig = {
				enabled: partial.enabled ?? state.enabled,
				hotkey: partial.hotkey ?? state.hotkey,
				language: partial.language ?? state.language,
				model: partial.model ?? state.selectedModel,
				device: partial.device !== undefined ? partial.device : state.selectedDevice,
				long_press_ms: partial.long_press_ms ?? state.longPressMs,
				auto_send: partial.auto_send ?? state.autoSend,
				rewrite_enabled: partial.rewrite_enabled ?? state.rewriteEnabled,
				rewrite_base_url: partial.rewrite_base_url ?? state.rewriteBaseUrl,
				rewrite_model: partial.rewrite_model ?? state.rewriteModel,
				rewrite_effort: partial.rewrite_effort !== undefined ? partial.rewrite_effort : state.rewriteEffort,
				rewrite_system_prompt: partial.rewrite_system_prompt ?? state.rewriteSystemPrompt,
				stt_provider: partial.stt_provider ?? state.sttProvider,
				stt_model_groq: partial.stt_model_groq ?? state.sttModelGroq,
				stt_model_openai: partial.stt_model_openai ?? state.sttModelOpenai,
				stt_base_url: partial.stt_base_url ?? state.sttBaseUrl,
				stt_model_custom: partial.stt_model_custom ?? state.sttModelCustom,
			};
			try {
				await invoke("set_dictation_config", { config });
				// Map DictationConfig fields to DictationStoreState fields
				const storeUpdate: Partial<DictationStoreState> = {};
				if (partial.enabled !== undefined) storeUpdate.enabled = partial.enabled;
				if (partial.hotkey !== undefined) storeUpdate.hotkey = partial.hotkey;
				if (partial.language !== undefined) storeUpdate.language = partial.language;
				if (partial.model !== undefined) storeUpdate.selectedModel = partial.model;
				if (partial.device !== undefined) storeUpdate.selectedDevice = partial.device;
				if (partial.long_press_ms !== undefined) storeUpdate.longPressMs = partial.long_press_ms;
				if (partial.auto_send !== undefined) storeUpdate.autoSend = partial.auto_send;
				if (partial.rewrite_enabled !== undefined) storeUpdate.rewriteEnabled = partial.rewrite_enabled;
				if (partial.rewrite_base_url !== undefined) storeUpdate.rewriteBaseUrl = partial.rewrite_base_url;
				if (partial.rewrite_model !== undefined) storeUpdate.rewriteModel = partial.rewrite_model;
				if (partial.rewrite_effort !== undefined) storeUpdate.rewriteEffort = partial.rewrite_effort;
				if (partial.rewrite_system_prompt !== undefined)
					storeUpdate.rewriteSystemPrompt = partial.rewrite_system_prompt;
				if (partial.stt_provider !== undefined) storeUpdate.sttProvider = partial.stt_provider;
				if (partial.stt_model_groq !== undefined) storeUpdate.sttModelGroq = partial.stt_model_groq;
				if (partial.stt_model_openai !== undefined) storeUpdate.sttModelOpenai = partial.stt_model_openai;
				if (partial.stt_base_url !== undefined) storeUpdate.sttBaseUrl = partial.stt_base_url;
				if (partial.stt_model_custom !== undefined) storeUpdate.sttModelCustom = partial.stt_model_custom;
				setState(storeUpdate);
			} catch (err) {
				appLogger.error("dictation", "Failed to save dictation config", err);
			}
		},

		setEnabled(value: boolean): void {
			actions.saveConfig({ enabled: value });
		},

		setHotkey(value: string): void {
			actions.saveConfig({ hotkey: value });
		},

		setCapturingHotkey(value: boolean): void {
			setState("capturingHotkey", value);
		},

		setLongPressMs(value: number): void {
			actions.saveConfig({ long_press_ms: value });
		},

		setAutoSend(value: boolean): void {
			actions.saveConfig({ auto_send: value });
		},

		setLanguage(value: string): void {
			actions.saveConfig({ language: value });
		},

		setDevice(value: string | null): void {
			actions.saveConfig({ device: value });
		},

		setRewriteEnabled(value: boolean): void {
			actions.saveConfig({ rewrite_enabled: value });
		},

		setRewriteBaseUrl(value: string): void {
			actions.saveConfig({ rewrite_base_url: value });
		},

		/** Set the rewrite model — resets effort in the same save (model change invalidates it) */
		setRewriteModel(value: string): void {
			actions.saveConfig({ rewrite_model: value, rewrite_effort: null });
		},

		setRewriteEffort(value: string | null): void {
			actions.saveConfig({ rewrite_effort: value });
		},

		setRewriteSystemPrompt(value: string): void {
			actions.saveConfig({ rewrite_system_prompt: value });
		},

		/** Fetch models from the configured rewrite endpoint's /models route */
		async fetchRewriteModels(): Promise<void> {
			const baseUrl = state.rewriteBaseUrl.trim();
			if (!baseUrl) {
				setState("rewriteModelsError", "Enter a base URL first");
				return;
			}
			setState({ fetchingRewriteModels: true, rewriteModelsError: null });
			try {
				const models = await invoke<RewriteModelInfo[]>("dictation_fetch_rewrite_models", { baseUrl });
				setState("rewriteModels", models);
			} catch (err) {
				setState("rewriteModelsError", String(err));
				appLogger.error("dictation", "Failed to fetch rewrite models", err);
			} finally {
				setState("fetchingRewriteModels", false);
			}
		},

		/** Refresh whether a rewrite API key is stored in the vault */
		async refreshRewriteKeyExists(): Promise<void> {
			try {
				const exists = await invoke<boolean>("dictation_rewrite_api_key_exists");
				setState("rewriteKeyExists", exists);
			} catch (err) {
				appLogger.error("dictation", "Failed to check rewrite API key", err);
			}
		},

		/** Save the rewrite API key to the vault (throws on failure — caller shows feedback) */
		async saveRewriteApiKey(key: string): Promise<void> {
			await invoke("set_dictation_rewrite_api_key", { key });
			setState("rewriteKeyExists", true);
		},

		/** Delete the rewrite API key from the vault (throws on failure — caller shows feedback) */
		async deleteRewriteApiKey(): Promise<void> {
			await invoke("delete_dictation_rewrite_api_key");
			setState("rewriteKeyExists", false);
		},

		/** Set the STT provider ("local" | "groq" | "openai") — clears fetched models */
		setSttProvider(provider: string): void {
			actions.saveConfig({ stt_provider: provider });
			setState({ sttModels: [], sttModelsError: null });
		},

		/** Set the transcription model for a cloud provider */
		setSttModel(provider: string, model: string): void {
			if (provider === "groq") {
				actions.saveConfig({ stt_model_groq: model });
			} else if (provider === "openai") {
				actions.saveConfig({ stt_model_openai: model });
			} else if (provider === "custom") {
				actions.saveConfig({ stt_model_custom: model });
			}
		},

		/** Fetch transcription-capable model ids from the provider's /models route */
		async fetchSttModels(provider: string): Promise<void> {
			setState({ fetchingSttModels: true, sttModelsError: null });
			try {
				const models = await invoke<string[]>("dictation_fetch_stt_models", { provider });
				setState("sttModels", models);
			} catch (err) {
				setState("sttModelsError", String(err));
				appLogger.error("dictation", "Failed to fetch STT models", err);
			} finally {
				setState("fetchingSttModels", false);
			}
		},

		/** Refresh whether an STT API key is stored in the vault for a provider */
		async refreshSttKeyExists(provider: string): Promise<void> {
			try {
				const exists = await invoke<boolean>("dictation_stt_api_key_exists", { provider });
				setState("sttKeyExists", provider, exists);
			} catch (err) {
				appLogger.error("dictation", "Failed to check STT API key", err);
			}
		},

		/** Save an STT API key to the vault (throws on failure — caller shows feedback) */
		async saveSttApiKey(provider: string, key: string): Promise<void> {
			await invoke("set_dictation_stt_api_key", { provider, key });
			setState("sttKeyExists", provider, true);
		},

		/** Delete an STT API key from the vault (throws on failure — caller shows feedback) */
		async deleteSttApiKey(provider: string): Promise<void> {
			await invoke("delete_dictation_stt_api_key", { provider });
			setState("sttKeyExists", provider, false);
		},

		/**
		 * Rewrite dictated text through the configured LLM endpoint.
		 * Returns null on ANY failure so callers fall back to the raw transcript.
		 * Never logs transcript content.
		 */
		async rewriteText(text: string): Promise<string | null> {
			setState("rewriting", true);
			try {
				return await invoke<string>("dictation_rewrite", { text });
			} catch (err) {
				appLogger.error("dictation", "AI rewrite failed", err);
				return null;
			} finally {
				setState("rewriting", false);
			}
		},

		/** Refresh status from Rust backend */
		async refreshStatus(): Promise<void> {
			try {
				const status = await invoke<DictationStatus>("get_dictation_status");
				setState({
					modelStatus: status.model_status,
					modelName: status.model_name,
					modelSizeMb: status.model_size_mb,
					recording: status.recording,
					processing: status.processing,
				});
			} catch (err) {
				appLogger.error("dictation", "Failed to get dictation status", err);
			}
		},

		/** Refresh correction map from Rust backend */
		async refreshCorrections(): Promise<void> {
			try {
				const map = await invoke<Record<string, string>>("get_correction_map");
				setState("corrections", map);
			} catch (err) {
				appLogger.error("dictation", "Failed to get correction map", err);
			}
		},

		/** Save correction map to Rust backend */
		async saveCorrections(map: Record<string, string>): Promise<void> {
			try {
				await invoke("set_correction_map", { map });
				setState("corrections", map);
			} catch (err) {
				appLogger.error("dictation", "Failed to save corrections", err);
			}
		},

		/** List available audio devices */
		async refreshDevices(): Promise<void> {
			try {
				const devices = await invoke<AudioDevice[]>("list_audio_devices");
				setState("devices", devices);
			} catch (err) {
				appLogger.error("dictation", "Failed to list audio devices", err);
			}
		},

		/** Fetch available model info from Rust backend */
		async refreshModels(): Promise<void> {
			try {
				const models = await invoke<ModelInfo[]>("get_model_info");
				setState("models", models);
			} catch (err) {
				appLogger.error("dictation", "Failed to get model info", err);
			}
		},

		/** Set the selected model and persist to config */
		async setModel(name: string): Promise<void> {
			await actions.saveConfig({ model: name });
			setState("selectedModel", name);
		},

		/** Delete a downloaded model and refresh the model list */
		async deleteModel(name: string): Promise<void> {
			try {
				await invoke("delete_whisper_model", { modelName: name });
				await actions.refreshModels();
			} catch (err) {
				appLogger.error("dictation", "Failed to delete model", err);
			}
		},

		/** Download a Whisper model (defaults to selectedModel) */
		async downloadModel(modelName?: string): Promise<void> {
			setState("downloading", true);
			setState("downloadPercent", 0);
			try {
				await invoke<string>("download_whisper_model", { modelName: modelName ?? state.selectedModel });
				await actions.refreshStatus();
				await actions.refreshModels();
			} catch (err) {
				appLogger.error("dictation", "Model download failed", err);
			} finally {
				setState("downloading", false);
			}
		},

		/** Start recording (sets loading=true while model initializes on first use) */
		async startRecording(): Promise<void> {
			setState("loading", true);
			try {
				await invoke("start_dictation");
				setState("recording", true);
			} catch (err) {
				const errStr = String(err);
				if (errStr.includes("microphone_denied")) {
					appLogger.error(
						"dictation",
						"Microphone access denied. Open System Settings > Privacy > Microphone to allow access.",
					);
					invoke("open_microphone_settings").catch(() => {});
				} else if (errStr.includes("microphone_restricted")) {
					appLogger.error("dictation", "Microphone access restricted by system policy");
				} else {
					appLogger.error("dictation", "Failed to start recording", err);
				}
				throw err;
			} finally {
				setState("loading", false);
			}
		},

		/** Stop recording and get transcription result */
		async stopRecording(): Promise<TranscribeResponse | null> {
			// Guard against concurrent stop calls — the Rust side rejects "Not recording"
			// but we avoid the noise by checking frontend state first.
			if (!state.recording) return null;
			// Optimistically clear recording so concurrent callers bail out above.
			setState("recording", false);
			try {
				const response = await invoke<TranscribeResponse>("stop_dictation_and_transcribe");
				setState("processing", false);
				setState("partialText", "");
				return response;
			} catch (err) {
				appLogger.error("dictation", "Failed to stop recording", err);
				setState("processing", false);
				setState("partialText", "");
				return null;
			}
		},

		/** Inject text (apply corrections) without recording */
		async injectText(text: string): Promise<string | null> {
			try {
				return await invoke<string>("inject_text", { text });
			} catch (err) {
				appLogger.error("dictation", "Failed to inject text", err);
				return null;
			}
		},
	};

	return { state, ...actions };
}

export const dictationStore = createDictationStore();
