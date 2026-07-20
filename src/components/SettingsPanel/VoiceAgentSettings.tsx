import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { voiceAgentStore } from "../../stores/voiceAgent";
import s from "./Settings.module.css";

interface AudioOutputDevice {
	name: string;
	is_default: boolean;
}

/** Voice Agent settings tab: talk to the AI, it controls terminals + sessions. */
export const VoiceAgentSettings: Component = () => {
	const [outputDevices, setOutputDevices] = createSignal<AudioOutputDevice[]>([]);
	const [testText, setTestText] = createSignal("Voice agent ready. I can prompt any of your sessions.");

	onMount(async () => {
		await voiceAgentStore.refreshConfig();
		await voiceAgentStore.refreshTtsStatus();
		try {
			setOutputDevices(await invoke<AudioOutputDevice[]>("list_audio_output_devices"));
		} catch (err) {
			appLogger.warn("voice-agent", "failed to list output devices", { error: String(err) });
		}
	});

	const provider = () => voiceAgentStore.state.ttsProvider;

	const cloudModel = () => {
		switch (provider()) {
			case "groq":
				return voiceAgentStore.state.ttsModelGroq;
			case "custom":
				return voiceAgentStore.state.ttsModelCustom;
			default:
				return voiceAgentStore.state.ttsModelOpenai;
		}
	};
	const cloudVoice = () => {
		switch (provider()) {
			case "groq":
				return voiceAgentStore.state.ttsVoiceGroq;
			case "custom":
				return voiceAgentStore.state.ttsVoiceCustom;
			default:
				return voiceAgentStore.state.ttsVoiceOpenai;
		}
	};
	const cloudModelPlaceholder = () => {
		switch (provider()) {
			case "groq":
				return "playai-tts";
			case "custom":
				return "tts-1";
			default:
				return "gpt-4o-mini-tts";
		}
	};
	const cloudVoicePlaceholder = () => (provider() === "groq" ? "Fritz-PlayAI" : "alloy");
	/** Key hint only applies to the cloud providers — custom is keyless-friendly. */
	const cloudKeyExists = () =>
		provider() === "groq" ? voiceAgentStore.state.groqKeyExists : voiceAgentStore.state.openaiKeyExists;

	const setCloudModel = (value: string) => {
		switch (provider()) {
			case "groq":
				void voiceAgentStore.saveConfig({ tts_model_groq: value });
				break;
			case "custom":
				void voiceAgentStore.saveConfig({ tts_model_custom: value });
				break;
			default:
				void voiceAgentStore.saveConfig({ tts_model_openai: value });
		}
	};
	const setCloudVoice = (value: string) => {
		switch (provider()) {
			case "groq":
				void voiceAgentStore.saveConfig({ tts_voice_groq: value });
				break;
			case "custom":
				void voiceAgentStore.saveConfig({ tts_voice_custom: value });
				break;
			default:
				void voiceAgentStore.saveConfig({ tts_voice_openai: value });
		}
	};

	const cloudModelOptions = () => {
		const models = voiceAgentStore.state.ttsModels;
		const saved = cloudModel();
		if (saved && !models.includes(saved)) {
			return [saved, ...models];
		}
		return models;
	};

	const sidecarLabel = () => {
		const st = voiceAgentStore.state.sidecar;
		if (!st) return t("voiceAgent.sidecarStopped", "not loaded");
		const detail = st.detail ? ` — ${st.detail}` : "";
		return `${st.state}${detail}`;
	};

	return (
		<div class={s.section}>
			<h3>{t("voiceAgent.title", "Voice Agent")}</h3>
			<p class={s.hint}>
				{t(
					"voiceAgent.intro",
					"Talk to the embedded AI while it controls your terminals and Claude Code sessions. " +
						"Speech-to-text uses your Dictation provider; replies are spoken with the engine below. " +
						"Start a session from the microphone button in the AI Chat panel.",
				)}
			</p>

			{/* Hands-free */}
			<div class={s.group}>
				<label>{t("voiceAgent.handsFreeLabel", "Hands-Free Mode")}</label>
				<div class={s.toggle}>
					<input
						type="checkbox"
						checked={voiceAgentStore.state.handsFree}
						onChange={(e) => void voiceAgentStore.saveConfig({ hands_free: e.currentTarget.checked })}
					/>
					<span>
						{t(
							"voiceAgent.handsFreeHint",
							"Detect utterances automatically (Silero VAD) with barge-in. Off = push-to-talk only via the dictation hotkey.",
						)}
					</span>
				</div>
			</div>

			{/* TTS engine */}
			<div class={s.group}>
				<label>{t("voiceAgent.ttsProviderLabel", "Text-to-Speech Engine")}</label>
				<select
					value={provider()}
					onChange={(e) => void voiceAgentStore.saveConfig({ tts_provider: e.currentTarget.value })}
				>
					<option value="kokoro">{t("voiceAgent.ttsKokoro", "Local — Kokoro (mlx-audio, Apple Silicon)")}</option>
					<option value="groq">{t("voiceAgent.ttsGroq", "Groq Cloud (playai-tts)")}</option>
					<option value="openai">{t("voiceAgent.ttsOpenai", "OpenAI")}</option>
					<option value="custom">{t("voiceAgent.ttsCustom", "Custom — OpenAI-compatible URL")}</option>
				</select>

				<Show when={provider() === "kokoro"}>
					<Show when={!voiceAgentStore.state.kokoroSupported}>
						<p class={s.hint} style={{ color: "var(--error)" }}>
							{t("voiceAgent.kokoroUnsupported", "Kokoro requires Apple Silicon — pick a cloud engine instead.")}
						</p>
					</Show>
					<Show when={voiceAgentStore.state.kokoroSupported && !voiceAgentStore.state.uvFound}>
						<p class={s.hint} style={{ color: "var(--error)" }}>
							{t(
								"voiceAgent.uvMissing",
								"uv not found — install it (https://docs.astral.sh/uv) to run the local Kokoro model.",
							)}
						</p>
					</Show>
					<div style={{ "margin-top": "8px" }}>
						<label>{t("voiceAgent.kokoroVoiceLabel", "Voice")}</label>
						<input
							class={s.input}
							type="text"
							placeholder="af_heart"
							value={voiceAgentStore.state.kokoroVoice}
							onChange={(e) => void voiceAgentStore.saveConfig({ kokoro_voice: e.currentTarget.value })}
						/>
						<p class={s.hint}>
							{t("voiceAgent.kokoroVoiceHint", "Kokoro voice id (af_heart, af_bella, am_adam, bf_emma, …)")}
						</p>
					</div>
					<div style={{ "margin-top": "8px" }}>
						<span class={s.hint}>
							{t("voiceAgent.sidecarState", "Model state:")} {sidecarLabel()}
						</span>
					</div>
					<div style={{ "margin-top": "6px", display: "flex", gap: "8px" }}>
						<button
							class={s.inlineBtn}
							onClick={() => void voiceAgentStore.kokoroPreload()}
							disabled={!voiceAgentStore.state.uvFound || !voiceAgentStore.state.kokoroSupported}
						>
							{t("voiceAgent.kokoroLoad", "Load model")}
						</button>
						<button
							class={s.inlineBtn}
							onClick={() => void voiceAgentStore.kokoroUnload()}
							disabled={voiceAgentStore.state.active}
						>
							{t("voiceAgent.kokoroUnload", "Unload (free RAM)")}
						</button>
					</div>
					<p class={s.hint} style={{ "margin-top": "6px" }}>
						{t(
							"voiceAgent.kokoroHint",
							"First load resolves mlx-audio via uv and downloads the ~330 MB Kokoro model; later loads take a few seconds.",
						)}
					</p>
				</Show>

				<Show when={provider() !== "kokoro"}>
					<Show when={provider() === "custom"}>
						<div style={{ "margin-top": "8px" }}>
							<label>{t("voiceAgent.ttsBaseUrlLabel", "Base URL")}</label>
							<input
								class={s.input}
								type="text"
								placeholder="http://127.0.0.1:8880/v1"
								value={voiceAgentStore.state.ttsBaseUrl}
								onChange={(e) => void voiceAgentStore.saveConfig({ tts_base_url: e.currentTarget.value.trim() })}
							/>
							<p class={s.hint}>
								{t(
									"voiceAgent.ttsBaseUrlHint",
									"Any OpenAI-compatible /audio/speech server (kokoro-fastapi, openedai-speech, …). Keyless local servers work.",
								)}
							</p>
						</div>
					</Show>
					<Show when={provider() !== "custom" && !cloudKeyExists()}>
						<p class={s.hint} style={{ color: "var(--error)", "margin-top": "8px" }}>
							{t(
								"voiceAgent.cloudKeyMissing",
								"No API key saved for this provider — add it under Settings → Dictation (the key is shared with cloud speech-to-text).",
							)}
						</p>
					</Show>
					<div style={{ "margin-top": "8px" }}>
						<button
							class={s.inlineBtn}
							onClick={() => void voiceAgentStore.fetchTtsModels(provider())}
							disabled={voiceAgentStore.state.fetchingTtsModels}
						>
							{voiceAgentStore.state.fetchingTtsModels
								? t("voiceAgent.fetchingModels", "Fetching…")
								: t("voiceAgent.fetchModels", "Fetch models")}
						</button>
						<Show when={voiceAgentStore.state.ttsModelsError}>
							<p class={s.hint} style={{ color: "var(--error)" }}>
								{voiceAgentStore.state.ttsModelsError}
							</p>
						</Show>
						<Show when={cloudModelOptions().length > 0}>
							<select
								value={cloudModel()}
								onChange={(e) => setCloudModel(e.currentTarget.value)}
								style={{ "margin-top": "6px" }}
							>
								<option value="">{t("voiceAgent.modelDefault", `Default (${cloudModelPlaceholder()})`)}</option>
								<For each={cloudModelOptions()}>{(id) => <option value={id}>{id}</option>}</For>
							</select>
						</Show>
					</div>
					<div style={{ "margin-top": "8px" }}>
						<label>{t("voiceAgent.cloudVoiceLabel", "Voice")}</label>
						<input
							class={s.input}
							type="text"
							placeholder={cloudVoicePlaceholder()}
							value={cloudVoice()}
							onChange={(e) => setCloudVoice(e.currentTarget.value)}
						/>
					</div>
				</Show>
			</div>

			{/* Output device */}
			<div class={s.group}>
				<label>{t("voiceAgent.outputDeviceLabel", "Audio Output")}</label>
				<select
					value={voiceAgentStore.state.outputDevice ?? ""}
					onChange={(e) => void voiceAgentStore.saveConfig({ output_device: e.currentTarget.value || null })}
				>
					<option value="">{t("voiceAgent.outputDefault", "System default")}</option>
					<For each={outputDevices()}>{(dev) => <option value={dev.name}>{dev.name}</option>}</For>
				</select>
				<p class={s.hint}>{t("voiceAgent.outputHint", "Device changes apply to the next voice session.")}</p>
			</div>

			{/* Test */}
			<div class={s.group}>
				<label>{t("voiceAgent.testLabel", "Test Voice")}</label>
				<div class={s.passwordRow}>
					<input class={s.input} type="text" value={testText()} onInput={(e) => setTestText(e.currentTarget.value)} />
					<button class={s.testBtn} onClick={() => void voiceAgentStore.speakTest(testText())}>
						{t("voiceAgent.speak", "Speak")}
					</button>
				</div>
				<Show when={voiceAgentStore.state.error}>
					<p class={s.hint} style={{ color: "var(--error)" }}>
						{voiceAgentStore.state.error}
					</p>
				</Show>
			</div>
		</div>
	);
};
