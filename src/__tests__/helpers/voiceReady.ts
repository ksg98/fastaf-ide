import { settingsStore } from "../../stores/settings";

/**
 * Backend answers for an install where voice is fully set up: dictation on,
 * the speech model and the voice on disk, a model connected for AI Chat.
 * Talk mode checks all of these before it opens the microphone, so a test
 * that starts a conversation needs them answered.
 */
export interface VoiceInstall {
	/** The speech-to-text model is on disk. */
	speech?: boolean;
	/** The voice FastAF answers with is on disk. */
	voice?: boolean;
	/** Dictation is switched on. */
	dictation?: boolean;
	/** AI Chat has a model in its main slot. */
	brain?: boolean;
}

export const VOICE_STATUS = {
	engine_state: "ready",
	loaded_model: "q8f16",
	session_active: true,
	muted: false,
	speaking: false,
	audio_level: 0,
	output_level: 0,
};

/** What the backend says for `cmd` on such an install, or `undefined` for anything else. */
export function voiceInstallAnswer(cmd: string, install: VoiceInstall = {}): unknown {
	const { speech = true, voice = true, dictation = true, brain = true } = install;
	switch (cmd) {
		case "get_dictation_config":
			return { enabled: dictation, hotkey: "F5", language: "auto", model: "large-v3-turbo-q5", stt_provider: "local" };
		case "get_model_info":
			return [
				{
					name: "large-v3-turbo-q5",
					display_name: "Turbo (Q5)",
					size_hint_mb: 574,
					downloaded: speech,
					actual_size_mb: 574,
				},
				{ name: "large-v3-turbo", display_name: "Turbo", size_hint_mb: 1620, downloaded: false, actual_size_mb: 0 },
			];
		case "voice_get_config":
			return { model: "q8f16", voice: "af_heart", speed: 1, barge_in: true, output_device: null, speak_up: true };
		case "voice_model_info":
			return [{ name: "q8f16", display_name: "Kokoro", size_hint_mb: 86, downloaded: voice, actual_size_mb: 86 }];
		case "voice_list_voices":
			return [{ id: "af_heart", display_name: "Heart", downloaded: voice }];
		case "voice_status":
			return VOICE_STATUS;
		case "load_provider_registry":
			return { schema_version: 1, providers: [], models: [], slots: brain ? { main: "model-1" } : {}, features: {} };
		default:
			return undefined;
	}
}

/** Switch AI Chat on the way Settings does; returns the function that switches it back off. */
export function enableAiChat(): () => void {
	settingsStore.setExperimentalFeaturesEnabled(true);
	settingsStore.setAiChatEnabled(true);
	return () => {
		settingsStore.setAiChatEnabled(false);
		settingsStore.setExperimentalFeaturesEnabled(false);
		settingsStore._testCancelPendingSave();
	};
}
