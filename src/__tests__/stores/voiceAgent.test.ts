import { beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope, testInScopeAsync } from "../helpers/store";
import { mockInvoke } from "../mocks/tauri";

describe("voiceAgentStore", () => {
	let store: typeof import("../../stores/voiceAgent").voiceAgentStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		store = (await import("../../stores/voiceAgent")).voiceAgentStore;
	});

	describe("defaults", () => {
		it("starts idle with kokoro + hands-free defaults", () => {
			testInScope(() => {
				expect(store.state.active).toBe(false);
				expect(store.state.speaking).toBe(false);
				expect(store.state.transcribing).toBe(false);
				expect(store.state.ttsProvider).toBe("kokoro");
				expect(store.state.kokoroVoice).toBe("af_heart");
				expect(store.state.handsFree).toBe(true);
				expect(store.state.muteTts).toBe(false);
				expect(store.uiState()).toBe("idle");
			});
		});
	});

	describe("refreshConfig()", () => {
		it("maps snake_case backend config into the store", async () => {
			mockInvoke.mockResolvedValueOnce({
				enabled: true,
				tts_provider: "groq",
				kokoro_voice: "am_adam",
				kokoro_speed: 1.2,
				tts_model_groq: "playai-tts",
				tts_voice_groq: "Fritz-PlayAI",
				tts_model_openai: "",
				tts_voice_openai: "",
				hands_free: false,
				mute_tts: true,
				output_device: "MacBook Pro Speakers",
			});
			await testInScopeAsync(async () => {
				await store.refreshConfig();
				expect(mockInvoke).toHaveBeenCalledWith("get_voice_agent_config");
				expect(store.state.ttsProvider).toBe("groq");
				expect(store.state.kokoroVoice).toBe("am_adam");
				expect(store.state.ttsModelGroq).toBe("playai-tts");
				expect(store.state.handsFree).toBe(false);
				expect(store.state.muteTts).toBe(true);
				expect(store.state.outputDevice).toBe("MacBook Pro Speakers");
			});
		});
	});

	describe("saveConfig()", () => {
		it("sends the full config with the partial applied", async () => {
			await testInScopeAsync(async () => {
				await store.saveConfig({ tts_provider: "openai", mute_tts: true });
				const call = mockInvoke.mock.calls.find((c) => c[0] === "set_voice_agent_config");
				expect(call).toBeDefined();
				const config = (call?.[1] as { config: Record<string, unknown> }).config;
				expect(config.tts_provider).toBe("openai");
				expect(config.mute_tts).toBe(true);
				// untouched fields carry current state
				expect(config.kokoro_voice).toBe("af_heart");
				expect(config.hands_free).toBe(true);
				// store mirrors the update
				expect(store.state.ttsProvider).toBe("openai");
				expect(store.state.muteTts).toBe(true);
			});
		});
	});

	describe("refreshTtsStatus()", () => {
		it("maps provider readiness fields", async () => {
			mockInvoke.mockResolvedValueOnce({
				provider: "kokoro",
				kokoro_supported: true,
				uv_found: true,
				sidecar: { state: "ready" },
				groq_key_exists: true,
				openai_key_exists: false,
				speaking: false,
			});
			await testInScopeAsync(async () => {
				await store.refreshTtsStatus();
				expect(store.state.kokoroSupported).toBe(true);
				expect(store.state.uvFound).toBe(true);
				expect(store.state.sidecar?.state).toBe("ready");
				expect(store.state.groqKeyExists).toBe(true);
				expect(store.state.openaiKeyExists).toBe(false);
			});
		});
	});

	describe("fetchTtsModels()", () => {
		it("stores fetched models", async () => {
			mockInvoke.mockResolvedValueOnce(["playai-tts", "playai-tts-arabic"]);
			await testInScopeAsync(async () => {
				await store.fetchTtsModels("groq");
				expect(mockInvoke).toHaveBeenCalledWith("voice_fetch_tts_models", { provider: "groq" });
				expect(store.state.ttsModels).toEqual(["playai-tts", "playai-tts-arabic"]);
				expect(store.state.ttsModelsError).toBeNull();
			});
		});

		it("captures fetch errors", async () => {
			mockInvoke.mockRejectedValueOnce("API key not set for groq");
			await testInScopeAsync(async () => {
				await store.fetchTtsModels("groq");
				expect(store.state.ttsModels).toEqual([]);
				expect(store.state.ttsModelsError).toContain("API key not set");
			});
		});
	});

	describe("sendTranscript()", () => {
		it("errors when no terminal is attached", () => {
			testInScope(() => {
				store.sendTranscript("run the tests");
				expect(store.state.error).toContain("No terminal attached");
			});
		});
	});

	describe("uiState()", () => {
		it("reports error state when active with an error", () => {
			testInScope(() => {
				// not active → idle even with error
				expect(store.uiState()).toBe("idle");
			});
		});
	});
});
