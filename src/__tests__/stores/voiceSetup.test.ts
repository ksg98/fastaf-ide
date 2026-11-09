import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dictationStore } from "../../stores/dictation";
import { providerRegistryStore } from "../../stores/providerRegistry";
import { settingsStore } from "../../stores/settings";
import { SETUP_SPEECH_MODEL, voiceSetup } from "../../stores/voiceSetup";
import { enableAiChat, type VoiceInstall, voiceInstallAnswer } from "../helpers/voiceReady";
import { mockInvoke } from "../mocks/tauri";

/** What is on this pretend disk; downloads flip it, the way the backend does. */
let install: VoiceInstall;
/** The speech graph and the voice file are separate downloads. */
let graphOnDisk: boolean;
let voiceOnDisk: boolean;
let savedDictation: Record<string, unknown> | null;

const calls = (cmd: string) => mockInvoke.mock.calls.filter(([name]) => name === cmd);

beforeEach(() => {
	install = { speech: false, voice: false, dictation: false, brain: true };
	graphOnDisk = false;
	voiceOnDisk = false;
	savedDictation = null;
	mockInvoke.mockReset().mockImplementation(async (cmd: string, args?: unknown) => {
		switch (cmd) {
			case "download_whisper_model":
				install.speech = true;
				return "ok";
			case "voice_download_model":
				graphOnDisk = true;
				return "ok";
			case "voice_download_voice":
				voiceOnDisk = true;
				return "ok";
			case "voice_model_info":
				return [
					{
						name: "q8f16",
						display_name: "Kokoro",
						size_hint_mb: 86,
						downloaded: graphOnDisk || install.voice === true,
						actual_size_mb: 86,
					},
				];
			case "voice_list_voices":
				return [{ id: "af_heart", display_name: "Heart", downloaded: voiceOnDisk || install.voice === true }];
			case "set_dictation_config":
				savedDictation = (args as { config: Record<string, unknown> }).config;
				install.dictation = savedDictation.enabled === true;
				return undefined;
			default:
				return voiceInstallAnswer(cmd, install);
		}
	});
	providerRegistryStore._reset();
});

afterEach(() => {
	voiceSetup.dismiss();
	settingsStore.setAiChatEnabled(false);
	settingsStore.setExperimentalFeaturesEnabled(false);
	settingsStore._testCancelPendingSave();
});

describe("voiceSetup.needs", () => {
	it("lists everything a new install is missing", async () => {
		await voiceSetup.refresh();
		expect(voiceSetup.needs()).toEqual({ dictation: true, speech: true, voice: true, chat: true, brain: false });
		expect(voiceSetup.ready()).toBe(false);
	});

	it("is ready once dictation and AI Chat are on and both downloads are on disk", async () => {
		install = { speech: true, voice: true, dictation: true, brain: true };
		const off = enableAiChat();
		await voiceSetup.refresh();
		expect(voiceSetup.ready()).toBe(true);
		off();
	});

	// Catches: someone who keeps dictation switched off, with everything on
	// disk, being asked to "set up voice" every time they press Talk.
	it("does not ask an install with dictation off to set anything up", async () => {
		install = { speech: true, voice: true, dictation: false, brain: true };
		const off = enableAiChat();
		await voiceSetup.refresh();
		expect(voiceSetup.needs().dictation).toBe(true);
		expect(voiceSetup.ready()).toBe(true);
		off();
	});

	// Catches: setup reported as incomplete forever on an install that has no
	// model for AI Chat — which is a different job, with its own button.
	it("does not count a missing chat model against setup, but reports it", async () => {
		install = { speech: true, voice: true, dictation: true, brain: false };
		const off = enableAiChat();
		await voiceSetup.refresh();
		expect(voiceSetup.needs().brain).toBe(true);
		expect(voiceSetup.ready()).toBe(true);
		off();
	});
});

describe("voiceSetup.downloadMb", () => {
	it("adds up what is still to come: the small speech model and the voice", async () => {
		await voiceSetup.refresh();
		expect(voiceSetup.downloadMb()).toBe(574 + 86);
	});

	it("counts only what is missing", async () => {
		install.speech = true;
		await voiceSetup.refresh();
		expect(voiceSetup.downloadMb()).toBe(86);
	});
});

describe("voiceSetup.run", () => {
	it("turns dictation and AI Chat on and downloads the speech model and the voice", async () => {
		expect(await voiceSetup.run()).toBe(true);

		expect(savedDictation).toMatchObject({ enabled: true, model: SETUP_SPEECH_MODEL });
		expect(settingsStore.isAiChatEnabled()).toBe(true);
		// The small model, not the 1.6 GB default.
		expect(calls("download_whisper_model")[0]?.[1]).toEqual({ modelName: SETUP_SPEECH_MODEL });
		expect(calls("voice_download_model")).toHaveLength(1);
		expect(calls("voice_download_voice")).toHaveLength(1);
		expect(voiceSetup.state.step).toBe("done");
		expect(voiceSetup.ready()).toBe(true);
	});

	// Catches: a second 574 MB download on a machine that already dictates.
	it("downloads nothing that is already on disk", async () => {
		install = { speech: true, voice: false, dictation: true, brain: true };

		expect(await voiceSetup.run()).toBe(true);

		expect(calls("download_whisper_model")).toHaveLength(0);
		expect(calls("voice_download_model")).toHaveLength(1);
		// Dictation was already on with a model that is on disk: its config is left alone.
		expect(savedDictation).toBeNull();
	});

	it("says so, and stops, when the speech model does not arrive", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "download_whisper_model") throw new Error("network unreachable");
			return voiceInstallAnswer(cmd, install);
		});

		expect(await voiceSetup.run()).toBe(false);

		expect(voiceSetup.state.step).toBe("failed");
		expect(voiceSetup.state.error).toContain("speech model");
		expect(calls("voice_download_model")).toHaveLength(0);
	});

	it("does not run twice at once", async () => {
		const first = voiceSetup.run();
		expect(await voiceSetup.run()).toBe(false);
		expect(await first).toBe(true);
		expect(calls("download_whisper_model")).toHaveLength(1);
	});
});

describe("voiceSetup first prompt", () => {
	it("is taken exactly once", () => {
		expect(voiceSetup.takeFirstPrompt()).toBe(false);
		voiceSetup.requestFirstPrompt();
		expect(voiceSetup.takeFirstPrompt()).toBe(true);
		expect(voiceSetup.takeFirstPrompt()).toBe(false);
	});
});

describe("dictation left as it was", () => {
	it("keeps a speech model the user already chose and downloaded", async () => {
		mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
			if (cmd === "get_dictation_config") return { enabled: false, model: "large-v3-turbo", stt_provider: "local" };
			if (cmd === "get_model_info") {
				return [
					{ name: "large-v3-turbo", display_name: "Turbo", size_hint_mb: 1620, downloaded: true, actual_size_mb: 1620 },
				];
			}
			if (cmd === "set_dictation_config") {
				savedDictation = (args as { config: Record<string, unknown> }).config;
				return undefined;
			}
			return voiceInstallAnswer(cmd, { voice: true });
		});

		await voiceSetup.run();

		// Switched on, with the model that was already chosen — not swapped for the small one.
		expect(savedDictation).toMatchObject({ enabled: true, model: "large-v3-turbo" });
		expect(dictationStore.state.selectedModel).toBe("large-v3-turbo");
		expect(calls("download_whisper_model")).toHaveLength(0);
	});
});
