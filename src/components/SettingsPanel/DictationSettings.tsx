import { type Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { type ChatVoiceTarget, chatVoiceTargets } from "../../services/chatVoice";
import { settingOptions } from "../../services/settingsCatalogue";
import { appLogger } from "../../stores/appLogger";
import type { ModelInfo, SpeechAsset, SpeechEngineId } from "../../stores/dictation";
import { dictationStore, WHISPER_LANGUAGES } from "../../stores/dictation";
import { providerRegistryStore } from "../../stores/providerRegistry";
import { settingsExpertStore } from "../../stores/settingsExpert";
import { terminalsStore } from "../../stores/terminals";
import { isTauri } from "../../transport";
import { cx } from "../../utils";
import { keyFor } from "../../utils/hotkey";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { handsFreePhaseLabel } from "../DictationToast/handsFreePhaseLabel";
import { KeyComboCapture } from "../shared/KeyComboCapture";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { StatusBadge } from "../ui/StatusBadge";
import { Textarea } from "../ui/Textarea";
import d from "./DictationSettings.module.css";
import { ExpertSetting } from "./ExpertSetting";
import { SettingSlider, SettingToggle } from "./SettingFields";
import s from "./Settings.module.css";
import { EmptyState, ListRow, SectionCard, SettingPageHeader, SettingRow, StatusSummary } from "./SettingsPrimitives";

/**
 * Mirrors `audio.rs`: `meter_level = sqrt(rms * 20)`.
 *
 * The gate is a raw RMS and the meter is that curve, so a threshold shown in raw
 * units cannot be compared against the bar the user is watching. Both are drawn
 * on the meter's scale instead, and only converted back on save.
 */
const RMS_METER_SCALE = 20;

function rmsToMeter(rms: number): number {
	return Math.min(1, Math.sqrt(Math.max(0, rms) * RMS_METER_SCALE));
}

function meterToRms(meter: number): number {
	return (meter * meter) / RMS_METER_SCALE;
}

/** Progress presentation shared by recognition and reply asset downloads. */
const AssetDownloadProgress: Component<{ percent: number }> = (props) => (
	<div class={d.downloadProgress}>
		<div class={d.progressBar}>
			<div class={d.progressFill} style={{ transform: `scaleX(${props.percent / 100})` }} />
		</div>
		<span class={d.progressText}>{props.percent}%</span>
	</div>
);

/** Single model row in the model selector list */
const ModelRow: Component<{ model: ModelInfo }> = (props) => {
	// Deleting throws away a download of up to 1.6 GB, one click from "Use":
	// always ask first.
	const [confirmDelete, setConfirmDelete] = createSignal(false);
	const isSelected = () => dictationStore.state.selectedModel === props.model.name;
	const isDownloading = () =>
		dictationStore.state.downloading && dictationStore.state.selectedModel === props.model.name;

	const sizeLabel = () =>
		props.model.downloaded && props.model.actual_size_mb > 0
			? `${props.model.actual_size_mb} MB`
			: `~${props.model.size_hint_mb} MB`;

	return (
		<div class={cx(d.modelRow, isSelected() && d.active)} data-whisper-model={props.model.name}>
			<div class={d.modelInfo}>
				<span class={d.modelName}>{props.model.display_name}</span>
				<span class={d.modelSize}>{sizeLabel()}</span>
			</div>
			<Show when={!isDownloading()}>
				<span class={cx(d.modelBadge, props.model.downloaded && d.downloaded)}>
					{props.model.downloaded
						? t("dictation.downloaded", "Downloaded")
						: t("dictation.notDownloaded", "Not downloaded")}
				</span>
			</Show>
			<div class={d.modelActions}>
				<Show when={props.model.downloaded && !isSelected()}>
					<button
						class={d.modelSelect}
						data-setting-id="voice.model"
						onClick={() => dictationStore.setModel(props.model.name)}
					>
						{t("dictation.use", "Use")}
					</button>
				</Show>
				<Show when={props.model.downloaded && isSelected()}>
					<span class={d.modelActiveLabel}>{t("dictation.active", "Active")}</span>
				</Show>
				<Show when={!props.model.downloaded && !isDownloading()}>
					<button
						class={d.modelDownload}
						data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
						onClick={() => dictationStore.downloadModel(props.model.name)}
					>
						{t("dictation.download", "Download")}
					</button>
				</Show>
				<Show when={isDownloading()}>
					<AssetDownloadProgress percent={dictationStore.state.downloadPercent} />
				</Show>
				<Show when={props.model.downloaded}>
					<button
						class={d.modelDelete}
						data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
						onClick={() => setConfirmDelete(true)}
						title={t("dictation.deleteModel", "Delete model")}
						aria-label={t("dictation.deleteModel", "Delete model")}
					>
						&times;
					</button>
				</Show>
			</div>
			<ConfirmDialog
				visible={confirmDelete()}
				title={t("dictation.deleteModelTitle", "Delete model?")}
				message={`${props.model.display_name} (${sizeLabel()}) will be removed from this Mac. Using it again means downloading it again.`}
				confirmLabel={t("dictation.deleteModelConfirm", "Delete")}
				kind="warning"
				defaultButton="cancel"
				onClose={() => setConfirmDelete(false)}
				onConfirm={() => {
					setConfirmDelete(false);
					void dictationStore.deleteModel(props.model.name);
				}}
			/>
		</div>
	);
};

/** Dictation settings tab for the Settings panel */
export const DictationSettings: Component = () => {
	const [newFrom, setNewFrom] = createSignal("");
	const [newTo, setNewTo] = createSignal("");
	const [rewriteTestInput, setRewriteTestInput] = createSignal(
		"umm so basically can you uh fix the the login bug and and also add some tests for it",
	);
	const [rewriteTestResult, setRewriteTestResult] = createSignal("");
	const [rewriteBodyPreview, setRewriteBodyPreview] = createSignal("");
	const [rewriteBodyError, setRewriteBodyError] = createSignal("");
	const [rewriteTestError, setRewriteTestError] = createSignal("");
	const [rewriteTestBusy, setRewriteTestBusy] = createSignal(false);
	const [sttKeyInput, setSttKeyInput] = createSignal("");
	const [sttKeyMsg, setSttKeyMsg] = createSignal("");
	const [savingSttKey, setSavingSttKey] = createSignal(false);

	// Load data on mount. Auto-detect devices only if mic is already authorized
	// (avoids triggering the macOS TCC permission dialog unexpectedly).
	onMount(async () => {
		dictationStore.refreshConfig();
		dictationStore.refreshStatus();
		dictationStore.refreshCorrections();
		dictationStore.refreshModels();
		// Only feeds the AI Rewrite provider picker; a failed read must not
		// surface as an unhandled rejection from the whole page.
		void (async () => {
			try {
				await providerRegistryStore.hydrate();
			} catch (err) {
				appLogger.warn("dictation", "Failed to load the provider registry", err);
			}
		})();
		dictationStore.refreshSttKeyExists("groq");
		dictationStore.refreshSttKeyExists("openai");
		try {
			const perm = await invoke<string>("check_microphone_permission");
			if (perm === "authorized") {
				dictationStore.refreshDevices();
			} else if (perm === "denied" || perm === "restricted") {
				appLogger.warn(
					"dictation",
					`Microphone access ${perm} — grant permission in System Settings > Privacy > Microphone`,
				);
			}
		} catch {
			appLogger.warn("dictation", "Failed to check microphone permission");
		}
	});

	const handleAddCorrection = () => {
		const from = newFrom().trim();
		const to = newTo().trim();
		if (!from || !to) return;

		const updated = { ...dictationStore.state.corrections, [from]: to };
		dictationStore.saveCorrections(updated);
		setNewFrom("");
		setNewTo("");
	};

	const handleRemoveCorrection = (key: string) => {
		const updated = { ...dictationStore.state.corrections };
		delete updated[key];
		dictationStore.saveCorrections(updated);
	};

	const handleExportCorrections = () => {
		const json = JSON.stringify(dictationStore.state.corrections, null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "dictation-corrections.json";
		a.click();
		URL.revokeObjectURL(url);
	};

	const sttProvider = () => dictationStore.state.sttProvider;

	/** Saved transcription model for the active cloud provider */
	const sttModel = () =>
		sttProvider() === "groq" ? dictationStore.state.sttModelGroq : dictationStore.state.sttModelOpenai;

	/** Model dropdown options — the saved model is appended if absent from the fetch */
	const sttModelOptions = () => {
		const models = dictationStore.state.sttModels;
		const saved = sttModel();
		if (saved && !models.includes(saved)) {
			return [...models, saved];
		}
		return models;
	};

	const sttKeyExists = () => dictationStore.state.sttKeyExists[sttProvider()] ?? false;

	const handleSttProviderChange = (provider: string) => {
		dictationStore.setSttProvider(provider);
		setSttKeyInput("");
		setSttKeyMsg("");
		if (provider !== "local") {
			dictationStore.refreshSttKeyExists(provider);
		}
	};

	const handleSaveSttKey = async () => {
		if (!sttKeyInput().trim()) return;
		setSavingSttKey(true);
		setSttKeyMsg("");
		try {
			await dictationStore.saveSttApiKey(sttProvider(), sttKeyInput().trim());
			setSttKeyInput("");
			setSttKeyMsg(t("dictation.sttKeySaved", "Key saved"));
		} catch (e) {
			setSttKeyMsg(`Error: ${String(e)}`);
		} finally {
			setSavingSttKey(false);
		}
	};

	const handleDeleteSttKey = async () => {
		setSavingSttKey(true);
		try {
			await dictationStore.deleteSttApiKey(sttProvider());
			setSttKeyMsg(t("dictation.sttKeyRemoved", "Key removed"));
		} catch (e) {
			setSttKeyMsg(`Error: ${String(e)}`);
		} finally {
			setSavingSttKey(false);
		}
	};

	const rewriteProviders = createMemo(() => providerRegistryStore.state.registry.providers);

	/** The Main slot's model name, so the default option says what it resolves to. */
	const mainSlotLabel = () => {
		const reg = providerRegistryStore.state.registry;
		const mainId = reg.slots.main;
		const model = mainId ? reg.models.find((m) => m.id === mainId) : undefined;
		return model ? `${t("dictation.rewriteUseMain", "Same as AI Chat")} (${model.model_name})` : null;
	};

	/** The fetched entry for the saved model, if the list has been fetched. */
	const selectedRewriteModel = () =>
		dictationStore.state.rewriteModels.find((m) => m.id === dictationStore.state.rewriteModel);

	/** Model dropdown contents — the saved model is kept even when it is absent
	 *  from the fetch, so switching endpoints never silently drops the choice. */
	const rewriteModelOptions = createMemo(() => {
		const models = dictationStore.state.rewriteModels;
		const saved = dictationStore.state.rewriteModel;
		if (saved && !models.some((m) => m.id === saved)) {
			return [...models, { id: saved, supports_reasoning: false, effort_options: null, default_effort: null }];
		}
		return models;
	});

	/** Effort values the endpoint advertised for this model. Empty when it
	 *  enumerated none — the field then accepts whatever the endpoint takes. */
	const effortOptions = () => selectedRewriteModel()?.effort_options ?? [];

	const handleFetchRewriteModels = () => void dictationStore.fetchRewriteModels();

	const refreshBodyPreview = async () => {
		try {
			setRewriteBodyPreview(await invoke<string>("dictation_rewrite_request_preview", { text: rewriteTestInput() }));
			setRewriteBodyError("");
		} catch (e) {
			setRewriteBodyPreview("");
			setRewriteBodyError(String(e));
		}
	};

	const handleRewriteTest = async () => {
		const text = rewriteTestInput().trim();
		if (!text) return;
		setRewriteTestBusy(true);
		setRewriteTestResult("");
		setRewriteTestError("");
		const started = performance.now();
		try {
			const rewritten = await invoke<string>("dictation_rewrite", { text });
			setRewriteTestResult(`${rewritten}  (${((performance.now() - started) / 1000).toFixed(1)}s)`);
		} catch (e) {
			setRewriteTestError(String(e));
		} finally {
			setRewriteTestBusy(false);
		}
	};

	const handleImportCorrections = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const map = JSON.parse(text);
				if (typeof map === "object" && map !== null) {
					dictationStore.saveCorrections(map as Record<string, string>);
				}
			} catch {
				appLogger.error("dictation", "Failed to import corrections file");
			}
		};
		input.click();
	};

	// Speech-to-text first, text-to-speech last, never mixed: each section
	// keeps its own advanced controls at its bottom instead of pooling them in
	// a shared "Advanced" section. Every section component opens with its own
	// h3 heading — see `SpeechRecognition` for why that matters.
	return (
		<div class={s.section}>
			<SettingPageHeader title="Dictation" scope="This machine" breadcrumb="AI / Dictation" />
			<SectionCard title={t("dictation.heading.dictation", "Dictation")}>
				<Show when={dictationStore.state.ownedElsewhere}>
					<p class={s.hint}>
						{t(
							"dictation.ownedElsewhere",
							"Dictation is owned by another FastAF instance on this configuration. Use it there; this instance does not register the global hotkey, watch the Fn key or open the microphone. Restart this instance after the other one quits to take dictation over.",
						)}
					</p>
				</Show>

				<SettingToggle
					settingId="voice.enabled"
					row
					label={t("dictation.enableLabel", "Enable Dictation")}
					hint={t("dictation.enableHint", "Enable voice-to-text dictation")}
					checked={dictationStore.state.enabled}
					onChange={(checked) => dictationStore.setEnabled(checked)}
				/>

				{/* Hotkey — a global hotkey belongs to the machine running
			    FastAF, so a browser tab has none to configure. */}
				<Show when={isTauri()}>
					<SettingRow
						label={t("dictation.hotkeyLabel", "Hotkey")}
						hint={t(
							"dictation.hotkeyHint",
							"Hold the hotkey to start recording, release to stop. Short presses pass through as normal input.",
						)}
					>
						{(_id, _descriptionId) => (
							<>
								<div class={d.hotkeyRow}>
									<KeyComboCapture
										settingId="voice.hotkey"
										value={dictationStore.state.hotkey}
										onChange={(combo) => dictationStore.setHotkey(combo)}
										placeholder={t("dictation.hotkeyPlaceholder", "Press a key combination...")}
										onCapturingChange={(capturing) => dictationStore.setCapturingHotkey(capturing)}
									/>
								</div>
							</>
						)}
					</SettingRow>

					<ExpertSetting configKey="dictation.long_press_ms" value={dictationStore.state.longPressMs}>
						<SettingSlider
							settingId="voice.long_press_ms"
							row
							label={t("dictation.longPressLabel", "Long-press threshold")}
							value={dictationStore.state.longPressMs}
							onChange={(v) => dictationStore.setLongPressMs(v)}
							min={0}
							max={1000}
							step={50}
							formatValue={(v) => (v === 0 ? t("dictation.instant", "Instant") : `${v}ms`)}
							hint={t(
								"dictation.longPressHint",
								"How long to hold the key before dictation starts. 0 = instant (no short-press pass-through), higher = fewer accidental triggers.",
							)}
						/>
					</ExpertSetting>
				</Show>

				<ExpertSetting configKey="dictation.auto_send" value={dictationStore.state.autoSend}>
					<SettingToggle
						settingId="voice.auto_send"
						row
						label={t("dictation.autoSendLabel", "Auto-send")}
						hint={t("dictation.autoSendHint", "Automatically press Enter after inserting transcribed text")}
						checked={dictationStore.state.autoSend}
						onChange={(checked) => dictationStore.setAutoSend(checked)}
					/>
				</ExpertSetting>
			</SectionCard>
			<SectionCard title={t("dictation.heading.sttProvider", "Speech-to-text provider")}>
				{/* Speech-to-text provider */}
				<div class={s.group}>
					<label>{t("dictation.sttProviderLabel", "Speech-to-Text Provider")}</label>
					<select
						data-setting-id="voice.stt_provider"
						value={sttProvider()}
						onChange={(e) => handleSttProviderChange(e.currentTarget.value)}
					>
						<option value="local">{t("dictation.sttProviderLocal", "Local — whisper.cpp (on-device)")}</option>
						<option value="groq">{t("dictation.sttProviderGroq", "Groq Cloud")}</option>
						<option value="openai">{t("dictation.sttProviderOpenai", "OpenAI")}</option>
					</select>
					<Show when={sttProvider() !== "local"}>
						{/* API key (required) */}
						<div style={{ "margin-top": "8px" }}>
							<div class={s.passwordRow}>
								<input
									class={s.input}
									data-non-setting="API keys live in the OS keychain, not in a configuration field"
									type="password"
									placeholder={
										sttKeyExists()
											? t("dictation.sttKeyReplace", "Replace existing key…")
											: t("dictation.sttKeyEnter", "Enter API key…")
									}
									value={sttKeyInput()}
									onInput={(e) => setSttKeyInput(e.currentTarget.value)}
								/>
								<button
									class={s.saveBtn}
									data-non-setting="API keys live in the OS keychain, not in a configuration field"
									onClick={handleSaveSttKey}
									disabled={savingSttKey() || !sttKeyInput().trim()}
								>
									{t("dictation.sttKeySave", "Save")}
								</button>
								<Show when={sttKeyExists()}>
									<button
										class={s.testBtn}
										data-non-setting="API keys live in the OS keychain, not in a configuration field"
										onClick={handleDeleteSttKey}
										disabled={savingSttKey()}
										style={{ color: "var(--error)" }}
									>
										{t("dictation.sttKeyRemove", "Remove")}
									</button>
								</Show>
							</div>
							<p class={s.hint}>{t("dictation.sttKeyHint", "API key required")}</p>
							<Show when={sttKeyMsg()}>
								<div class={s.hint}>{sttKeyMsg()}</div>
							</Show>
						</div>

						{/* Transcription model */}
						<div style={{ "margin-top": "8px" }}>
							<button
								class={s.inlineBtn}
								data-non-setting="Reads the provider's model list; does not change configuration"
								onClick={() => dictationStore.fetchSttModels(sttProvider())}
								disabled={dictationStore.state.fetchingSttModels}
							>
								{dictationStore.state.fetchingSttModels
									? t("dictation.sttFetchingModels", "Fetching…")
									: t("dictation.sttFetchModels", "Fetch models")}
							</button>
							<Show when={dictationStore.state.sttModelsError}>
								<p class={s.hint} style={{ color: "var(--error)" }}>
									{dictationStore.state.sttModelsError}
								</p>
							</Show>
							<Show when={sttModelOptions().length > 0}>
								<select
									data-setting-id={sttProvider() === "groq" ? "voice.stt_model_groq" : "voice.stt_model_openai"}
									value={sttModel()}
									onChange={(e) => dictationStore.setSttModel(sttProvider(), e.currentTarget.value)}
									style={{ "margin-top": "6px" }}
								>
									<option value="">{t("dictation.sttModelNone", "Select a model…")}</option>
									<For each={sttModelOptions()}>{(id) => <option value={id}>{id}</option>}</For>
								</select>
							</Show>
						</div>

						<p class={s.hint} style={{ "margin-top": "8px" }}>
							{t(
								"dictation.sttCloudHint",
								"Live partial preview is unavailable with cloud providers — text appears when you stop recording.",
							)}
						</p>
					</Show>
				</div>
			</SectionCard>
			<SpeechRecognition />

			<SectionCard title={t("dictation.heading.rewrite", "AI Rewrite")}>
				{/* A toggle row like every other card's first row: the card title
				    already says what it is, so the row names the action. */}
				<SettingToggle
					settingId="voice.rewrite_enabled"
					row
					label={t("dictation.rewriteEnableLabel", "Rewrite transcripts")}
					hint={t("dictation.rewriteEnableHint", "An AI model cleans up each transcript before it is inserted")}
					checked={dictationStore.state.rewriteEnabled}
					onChange={(checked) => dictationStore.setRewriteEnabled(checked)}
				/>
				<Show when={dictationStore.state.rewriteEnabled}>
					<div class={s.group}>
						{/* Provider — from the registry, so AI is configured in one place */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteProviderLabel", "Provider")}</label>
							<select
								data-setting-id="voice.rewrite_provider_id"
								value={dictationStore.state.rewriteProviderId}
								onChange={(e) => dictationStore.setRewriteProviderId(e.currentTarget.value)}
							>
								<option value="">{mainSlotLabel() ?? t("dictation.rewriteUseMain", "Same as AI Chat")}</option>
								<For each={rewriteProviders()}>
									{(provider) => <option value={provider.id}>{provider.label}</option>}
								</For>
							</select>
							<p class={s.hint}>
								{t(
									"dictation.rewriteProviderHint",
									"Providers come from Settings → Providers — the same endpoints and keys as AI Chat.",
								)}
							</p>
							<Show when={rewriteProviders().length === 0}>
								<p class={s.hint} style={{ color: "var(--error)" }}>
									{t(
										"dictation.rewriteNoProviders",
										"No AI providers configured yet — add one under Settings → Providers.",
									)}
								</p>
							</Show>
						</div>

						{/* Model — asked for live, never hardcoded */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteModelLabel", "Model")}</label>
							<div class={s.passwordRow}>
								<Show when={rewriteModelOptions().length > 0} fallback={<span class={s.hint} />}>
									<select
										class={s.input}
										data-setting-id="voice.rewrite_model"
										value={dictationStore.state.rewriteModel}
										onChange={(e) => dictationStore.setRewriteModel(e.currentTarget.value)}
									>
										<option value="">{t("dictation.rewriteModelNone", "Select a model…")}</option>
										<For each={rewriteModelOptions()}>{(model) => <option value={model.id}>{model.id}</option>}</For>
									</select>
								</Show>
								<button
									class={s.testBtn}
									data-non-setting="Reads the provider's model list; does not change configuration"
									onClick={handleFetchRewriteModels}
									disabled={dictationStore.state.fetchingRewriteModels}
								>
									{dictationStore.state.fetchingRewriteModels
										? t("dictation.rewriteFetchingModels", "Fetching…")
										: t("dictation.rewriteFetchModels", "Fetch models")}
								</button>
							</div>
							<p class={s.hint}>
								{t(
									"dictation.rewriteModelHint",
									"Models are read from the provider's /models endpoint every time you fetch — nothing is hardcoded.",
								)}
							</p>
							<Show when={dictationStore.state.rewriteModelsError}>
								<p class={s.hint} style={{ color: "var(--error)" }}>
									{dictationStore.state.rewriteModelsError}
								</p>
							</Show>
						</div>

						{/* Reasoning effort — the vocabulary the endpoint advertised for this model */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteEffortLabel", "Reasoning effort")}</label>
							<Show
								when={effortOptions().length > 0}
								fallback={
									<input
										class={s.input}
										data-setting-id="voice.rewrite_effort"
										type="text"
										placeholder={t("dictation.rewriteEffortPlaceholder", "unset — model decides")}
										value={dictationStore.state.rewriteEffort ?? ""}
										onChange={(e) => dictationStore.setRewriteEffort(e.currentTarget.value.trim() || null)}
									/>
								}
							>
								<select
									data-setting-id="voice.rewrite_effort"
									value={dictationStore.state.rewriteEffort ?? ""}
									onChange={(e) =>
										dictationStore.setRewriteEffort(e.currentTarget.value === "" ? null : e.currentTarget.value)
									}
								>
									<option value="">{t("dictation.rewriteEffortDefault", "Default (model decides)")}</option>
									<For each={effortOptions()}>
										{(effort) => (
											<option value={effort}>
												{effort === selectedRewriteModel()?.default_effort ? `${effort} (default)` : effort}
											</option>
										)}
									</For>
								</select>
							</Show>
							<p class={s.hint}>
								<Show
									when={effortOptions().length > 0}
									fallback={t(
										"dictation.rewriteEffortFree",
										"This model advertises no effort levels — anything you type is sent as reasoning_effort, and blank omits it.",
									)}
								>
									{t("dictation.rewriteEffortAdvertised", "Levels advertised by the endpoint for this model.")}
								</Show>
							</p>
						</div>

						{/* System prompt */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewritePromptLabel", "System prompt")}</label>
							<textarea
								data-setting-id="voice.rewrite_system_prompt"
								rows={5}
								value={dictationStore.state.rewriteSystemPrompt}
								onChange={(e) => dictationStore.setRewriteSystemPrompt(e.currentTarget.value)}
							/>
							<p class={s.hint}>
								{t(
									"dictation.rewritePromptHint",
									"Instructions for the rewrite model. Saved when the field loses focus.",
								)}
							</p>
						</div>

						{/* Request body — merged last, so it can override anything above */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteBodyLabel", "Extra request body (JSON)")}</label>
							<textarea
								data-setting-id="voice.rewrite_extra_body"
								rows={3}
								placeholder={'{ "top_p": 0.9 }'}
								value={dictationStore.state.rewriteExtraBody}
								onChange={(e) => dictationStore.setRewriteExtraBody(e.currentTarget.value)}
							/>
							<p class={s.hint}>
								{t(
									"dictation.rewriteBodyHint",
									"Merged into the chat-completions body and applied last, so it can override the composed fields — e.g. an endpoint that wants reasoning: {effort} instead of reasoning_effort.",
								)}
							</p>
							<button
								class={s.inlineBtn}
								data-non-setting="Shows the request the rewrite would send; does not change configuration"
								onClick={() => void refreshBodyPreview()}
							>
								{t("dictation.rewriteShowBody", "Show request body")}
							</button>
							<Show when={rewriteBodyPreview()}>
								<pre class={s.hint} style={{ "white-space": "pre-wrap", "margin-top": "6px" }}>
									{rewriteBodyPreview()}
								</pre>
							</Show>
							<Show when={rewriteBodyError()}>
								<p class={s.hint} style={{ color: "var(--error)" }}>
									{rewriteBodyError()}
								</p>
							</Show>
						</div>

						{/* Test — runs the real rewrite path and surfaces the raw error on failure */}
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteTestLabel", "Test rewrite")}</label>
							<div class={s.passwordRow}>
								<input
									class={s.input}
									data-non-setting="Sample text for a test rewrite; not stored"
									type="text"
									value={rewriteTestInput()}
									onInput={(e) => setRewriteTestInput(e.currentTarget.value)}
								/>
								<button
									class={s.testBtn}
									data-non-setting="Runs a test rewrite; does not change configuration"
									onClick={handleRewriteTest}
									disabled={rewriteTestBusy()}
								>
									{rewriteTestBusy() ? t("dictation.rewriteTesting", "Testing…") : t("dictation.rewriteTest", "Test")}
								</button>
							</div>
							<Show when={rewriteTestResult()}>
								<p class={s.hint}>{rewriteTestResult()}</p>
							</Show>
							<Show when={rewriteTestError()}>
								<p class={s.hint} style={{ color: "var(--error)" }}>
									{rewriteTestError()}
								</p>
							</Show>
						</div>
					</div>
				</Show>
			</SectionCard>
			<SectionCard
				title={t("dictation.heading.corrections", "Auto-Corrections")}
				description={t(
					"dictation.correctionsHint",
					"Automatically replace dictation output. Useful for technical terms.",
				)}
				actions={
					<>
						<Button
							data-setting-id="corrections.replacements.{from}.to"
							class={s.testBtn}
							onClick={handleImportCorrections}
						>
							{t("dictation.import", "Import")}
						</Button>
						<Button
							data-non-setting="Export the correction map without changing owner configuration"
							class={s.testBtn}
							onClick={handleExportCorrections}
						>
							{t("dictation.export", "Export")}
						</Button>
					</>
				}
			>
				<For
					each={Object.entries(dictationStore.state.corrections)}
					fallback={
						<EmptyState title="No corrections" description="Add a replacement for words dictation often mishears." />
					}
				>
					{([from, to]) => (
						<ListRow
							name={`${from} → ${to}`}
							actions={
								<Button
									data-setting-id="corrections.replacements.{from}.to"
									class={s.testBtn}
									onClick={() => handleRemoveCorrection(from)}
									title={t("dictation.removeCorrection", "Remove correction")}
								>
									{t("dictation.removeCorrection", "Remove correction")}
								</Button>
							}
						/>
					)}
				</For>
				<SettingRow label="Add correction" hint="Replace heard text with the spelling you want.">
					{(id, descriptionId) => (
						<div class={s.passwordRow}>
							<Input
								id={id}
								aria-describedby={descriptionId()}
								type="text"
								placeholder={t("dictation.correctionFromPlaceholder", "Heard text...")}
								data-setting-id="corrections.replacements.{from}.from"
								value={newFrom()}
								onInput={(e) => setNewFrom(e.currentTarget.value)}
								onKeyDown={(e) => e.key === "Enter" && handleAddCorrection()}
							/>
							<Input
								aria-label={t("dictation.correctionsTo", "To")}
								type="text"
								placeholder={t("dictation.correctionToPlaceholder", "Replace with...")}
								data-setting-id="corrections.replacements.{from}.to"
								value={newTo()}
								onInput={(e) => setNewTo(e.currentTarget.value)}
								onKeyDown={(e) => e.key === "Enter" && handleAddCorrection()}
							/>
							<Button
								data-setting-id="corrections.replacements.{from}.to"
								class={s.testBtn}
								onClick={handleAddCorrection}
								disabled={!newFrom().trim() || !newTo().trim()}
							>
								{t("dictation.addCorrection", "Add")}
							</Button>
						</div>
					)}
				</SettingRow>
			</SectionCard>
			{/* FastAF's voice agent (Settings › Voice) is the hands-free mode on the
			    desktop, so upstream's own conversation and its speech engine are a
			    browser-only path: a browser holds that conversation through its own
			    microphone and speaker (#832-e730). Gated here so their polling and
			    voice-list fetches never start on the desktop; each card repeats the
			    gate so the search index marks its labels browser-only. */}
			<Show when={!isTauri()}>
				<HandsFreeControls />
				<SpeechSetup />
			</Show>
		</div>
	);
};

/**
 * Speech-to-text: the microphone, the Whisper model and language, and — last,
 * as this section's advanced part — the live harness for the two speech gates.
 *
 * Opens with its own h3 heading, as do `HandsFreeControls` and `SpeechSetup`.
 * `extractSettings` builds the settings search index from source order and
 * assigns each label to the nearest preceding h3 heading; it does not follow the
 * render tree. A sub-component without a heading of its own would have its
 * labels filed under whichever heading happens to precede its definition —
 * or, defined above the panel, under none, which makes them unreachable from
 * settings search.
 *
 * The test recording reports the transcript back into the panel instead of
 * typing it into a terminal: tuning a gate means seeing what it rejected, and a
 * threshold that swallows speech is indistinguishable from a dead microphone
 * until the skip reason is on screen.
 */
const SpeechRecognition: Component = () => {
	const [testText, setTestText] = createSignal<string | null>(null);

	const recording = () => dictationStore.state.recording;
	const thresholdPercent = () => rmsToMeter(dictationStore.state.rmsThreshold) * 100;
	const levelPercent = () => dictationStore.state.audioLevel * 100;

	/** Replies follow this language, so one with no speech bundle stays silent
	 *  under Pocket TTS. The external command picks its own, so only Pocket is
	 *  limited by the bundles.
	 *  Auto has no fixed language, and an empty catalogue has not loaded yet. */
	const isVoiceless = (code: string): boolean => {
		const assets = dictationStore.state.speechAssets;
		return (
			// Desktop replies come from FastAF's voice agent, not Pocket bundles.
			!isTauri() &&
			dictationStore.state.speechEngine === "pocket" &&
			code !== "auto" &&
			assets.length > 0 &&
			!assets.some((asset) => asset.language === code)
		);
	};

	const toggleTest = async () => {
		if (recording()) {
			const result = await dictationStore.stopRecording();
			setTestText(result?.text.trim() || null);
			return;
		}
		setTestText(null);
		try {
			await dictationStore.startRecording();
		} catch {
			// startRecording logs the failure; lastSkipReason covers the rest.
		}
	};

	return (
		<>
			<SectionCard title={t("dictation.heading.recognition", "Speech recognition")}>
				{/* Audio devices — this list is the *server's* hardware. A browser
			    captures from its own device, chosen by the browser's own
			    permission prompt, so offering these names there would let a
			    user pick a microphone in another building. */}
				<Show when={isTauri()}>
					<ExpertSetting configKey="dictation.device" value={dictationStore.state.selectedDevice}>
						<SettingRow
							label={t("dictation.inputDeviceLabel", "Input device")}
							hint={
								dictationStore.state.devices.length > 0
									? t("dictation.microphoneHint", "Select the input device to use for dictation.")
									: t("dictation.detectMicrophonesHint", "Triggers macOS microphone permission dialog.")
							}
						>
							{(id, descriptionId) => (
								<>
									<Show
										when={dictationStore.state.devices.length > 0}
										fallback={
											<div>
												<Button
													data-non-setting="Explicit device discovery; does not select a device"
													class={s.testBtn}
													onClick={() => dictationStore.refreshDevices()}
												>
													{t("dictation.detectMicrophones", "Detect Microphones")}
												</Button>
											</div>
										}
									>
										<Select
											data-setting-id="voice.device"
											id={id}
											aria-describedby={descriptionId()}
											value={dictationStore.state.selectedDevice ?? ""}
											onChange={(e) => {
												const val = e.currentTarget.value;
												dictationStore.setDevice(val === "" ? null : val);
											}}
										>
											<option value="">{t("dictation.systemDefault", "System Default")}</option>
											<For each={dictationStore.state.devices}>
												{(device) => <option value={device.name}>{device.name}</option>}
											</For>
										</Select>
									</Show>
								</>
							)}
						</SettingRow>
					</ExpertSetting>
				</Show>

				<SettingRow label={t("dictation.languageLabel", "Language")}>
					{(id, descriptionId) => (
						<>
							<Select
								data-setting-id="voice.language"
								id={id}
								aria-describedby={descriptionId()}
								value={dictationStore.state.language}
								onChange={(e) => dictationStore.setLanguage(e.currentTarget.value)}
							>
								<For each={Object.entries(WHISPER_LANGUAGES)}>
									{([value, label]) => (
										<option value={value}>
											{isVoiceless(value)
												? t("dictation.languageNoVoice", "{lang} — no spoken replies").replace("{lang}", label)
												: label}
										</option>
									)}
								</For>
							</Select>

							<Show when={isVoiceless(dictationStore.state.language)}>
								<p class={s.hint}>
									{t(
										"dictation.languageNoVoiceHint",
										"Replies in this language will not be spoken. Whisper also expects you to speak it — if you talk in another language, choose it or Auto-detect.",
									)}
								</p>
							</Show>
						</>
					)}
				</SettingRow>

				{/* This section's advanced part: only needed once speech is cut or
			    noise gets through. */}

				<ExpertSetting configKey="dictation.rms_threshold" value={dictationStore.state.rmsThreshold}>
					<SettingSlider
						settingId="voice.rms_threshold"
						row
						label={t("dictation.rmsLabel", "Level gate")}
						value={Math.round(thresholdPercent())}
						onChange={(v) => dictationStore.setRmsThreshold(meterToRms(v / 100))}
						min={0}
						max={50}
						step={1}
						formatValue={(v) => `${v}%`}
						hint={t("dictation.rmsHint", "Audio below this level is ignored.")}
					/>
				</ExpertSetting>

				<ExpertSetting configKey="dictation.no_speech_threshold" value={dictationStore.state.noSpeechThreshold}>
					<SettingSlider
						settingId="voice.no_speech_threshold"
						row
						label={t("dictation.noSpeechLabel", "Speech confidence gate")}
						value={Math.round(dictationStore.state.noSpeechThreshold * 100)}
						onChange={(v) => dictationStore.setNoSpeechThreshold(v / 100)}
						min={10}
						max={100}
						step={5}
						formatValue={(v) => (v === 100 ? t("dictation.off", "Off") : `${v}%`)}
						hint={t(
							"dictation.noSpeechHint",
							"Discards a transcript when Whisper itself reports it probably heard no speech. Lower is stricter; 100% turns the gate off.",
						)}
					/>
				</ExpertSetting>
			</SectionCard>
			<SectionCard title="Speech assets" layout="aligned">
				{/* The Whisper models run on-device, so they only apply to the local
				    speech-to-text provider; a cloud provider names its own model above. */}
				<Show when={dictationStore.state.sttProvider === "local"}>
					<SettingRow
						label={t("dictation.modelLabel", "Whisper model")}
						hint={t("dictation.modelHint", "Choose a model. Larger models are more accurate but slower.")}
					>
						{() => (
							<div class={d.modelList}>
								<For each={dictationStore.state.models}>{(model: ModelInfo) => <ModelRow model={model} />}</For>
							</div>
						)}
					</SettingRow>
				</Show>
				<SettingRow
					label={t("dictation.tuningLabel", "Voice tuning")}
					hint={t(
						"dictation.tuningHint",
						"Record a test phrase and watch where your voice sits against the gates. Text stays in this panel — nothing is sent to a terminal.",
					)}
				>
					{() => (
						<>
							<div class={s.passwordRow}>
								<div class={d.tuningDisplay}>
									<div class={d.tuningMeter}>
										<div class={d.tuningLevel} style={{ transform: `scaleX(${dictationStore.state.audioLevel})` }} />
										<div
											class={d.tuningThreshold}
											style={{ left: `${thresholdPercent()}%` }}
											title={t("dictation.tuningThresholdMarker", "Level gate")}
										/>
									</div>
									<div class={d.tuningReadout}>
										<span>
											{t("dictation.tuningLevelReadout", "Level")}: {Math.round(levelPercent())}%
										</span>
										<span>
											{t("dictation.tuningGateReadout", "Gate")}: {Math.round(thresholdPercent())}%
										</span>
									</div>
								</div>
								<div class={d.controlRow}>
									<Button
										data-non-setting="Preview audio or test recording without changing the stored preference"
										class={s.testBtn}
										onClick={toggleTest}
										disabled={dictationStore.state.processing}
									>
										{recording()
											? t("dictation.tuningStop", "Stop test")
											: t("dictation.tuningStart", "Start test recording")}
									</Button>
								</div>
							</div>

							<Show when={dictationStore.state.partialText}>
								<p class={d.tuningPartial}>{dictationStore.state.partialText}</p>
							</Show>
							<Show when={testText()}>
								<p class={d.tuningResult}>{testText()}</p>
							</Show>
							<Show when={dictationStore.state.lastSkipReason}>
								<p class={d.tuningSkip}>
									{t("dictation.tuningSkipped", "Rejected")}: {dictationStore.state.lastSkipReason}
								</p>
							</Show>
						</>
					)}
				</SettingRow>
				<Show when={!isTauri()}>
					<details>
						<summary>Manage Pocket TTS voices</summary>
						<VoiceLibrary language={dictationStore.state.language} />
					</details>
				</Show>
			</SectionCard>
		</>
	);
};

/** Bytes as the megabytes a download dialog would quote. */
function megabytes(bytes: number): string {
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Setting up the voice that speaks replies back.
 *
 * Carries its own section heading for the same reason as `SpeechRecognition`: the settings
 * search index is built from source order and assigns each label to the
 * nearest preceding h3 heading.
 *
 * There is no language control here on purpose. A conversation is held in one
 * language, and that is the Whisper language above — picking a second one is
 * how you get a reply in English to a question asked in Italian. What the user
 * chooses here is which of that language's voices speaks it.
 *
 * Browser-only, like `HandsFreeControls`: it voices that conversation, and the
 * desktop speaks through FastAF's voice agent instead.
 */
const SpeechSetup: Component = () => {
	onMount(() => {
		dictationStore.refreshSpeechAssets();
	});

	const languageAsset = (): SpeechAsset | undefined =>
		dictationStore.state.speechAssets.find(
			(asset) => asset.kind === "language" && asset.language === dictationStore.state.language,
		);

	// A downloadable voice (`kind: "voice"`) belongs in the voice list below, not
	// in this list of downloads.
	const downloadRows = (): SpeechAsset[] => dictationStore.state.speechAssets.filter((asset) => asset.kind !== "voice");

	const engine = (): SpeechEngineId => dictationStore.state.speechEngine;

	// Re-read the language's voices whenever the catalogue moves (a voice was
	// downloaded, repaired or deleted) or the language changes.
	createEffect(() => {
		const code = dictationStore.state.language;
		void dictationStore.state.speechAssets;
		if (code !== "auto" && engine() === "pocket") void dictationStore.refreshSpeechVoices(code);
	});

	/** Whether there is a voice to choose: a Pocket language that ships voices.
	 * The external command names its own. */
	const hasVoicePicker = (): boolean => engine() === "pocket" && (languageAsset()?.voices.length ?? 0) > 0;

	// Include catalogue choices even before download: a stored missing choice
	// must remain selected instead of blanking the native select.
	const voiceAssets = () =>
		dictationStore.state.speechAssets.filter(
			(asset) => asset.kind === "voice" && asset.language === dictationStore.state.language,
		);
	const selectedMissingAsset = () =>
		voiceAssets().find((asset) => asset.voice === dictationStore.state.speechVoice && asset.state !== "ready");
	const voiceChoices = (): string[] => {
		const asset = languageAsset();
		const installed = dictationStore.state.speechVoices.map((voice) => voice.id);
		return [
			...new Set([
				...(asset?.state === "ready" ? asset.voices : []),
				...installed,
				...voiceAssets().flatMap((voice) => (voice.voice ? [voice.voice] : [])),
				...(dictationStore.state.speechVoice ? [dictationStore.state.speechVoice] : []),
			]),
		];
	};
	const voiceLabel = (voice: string): string => {
		const asset = voiceAssets().find((asset) => asset.voice === voice);
		return asset && asset.state !== "ready" ? `${voice} — ${t("dictation.notDownloaded", "Not downloaded")}` : voice;
	};

	const [previewError, setPreviewError] = createSignal<string | null>(null);
	const listen = async () => {
		const code = languageAsset()?.language;
		if (!code) return;
		setPreviewError(await dictationStore.previewSpeechVoice(code, dictationStore.state.speechVoice));
	};

	// The drag shows its value at once; the config is written on release.
	const [volumeDrag, setVolumeDrag] = createSignal<number | undefined>();
	const [levellingDrag, setLevellingDrag] = createSignal<number | undefined>();

	/** Which language replies are spoken in, in the user's terms. */
	const spokenLanguage = (): string => {
		const code = dictationStore.state.language;
		if (engine() === "external") return t("dictation.speechLanguageExternal", "Chosen by your command");
		if (code === "auto") {
			return t("dictation.speechLanguageAuto", "Whatever Whisper hears — nothing is spoken until somebody speaks");
		}
		const asset = languageAsset();
		return asset
			? asset.display_name
			: t("dictation.speechLanguageMissing", "{lang} — no speech bundle ships for it").replace(
					"{lang}",
					WHISPER_LANGUAGES[code] ?? code,
				);
	};

	return (
		<Show when={!isTauri()}>
			<SectionCard
				title={t("dictation.heading.spokenReplies", "Spoken replies")}
				layout="aligned"
				description={
					engine() === "pocket"
						? t(
								"dictation.speechHint",
								"Downloads needed to let an agent answer out loud. The runtime library is shared; each language is a separate bundle and brings its own voices.",
							)
						: t(
								"dictation.speechHintExternal",
								"Replies are spoken by the command below, which runs on this machine as you.",
							)
				}
			>
				<Show when={engine() === "pocket"}>
					<SettingRow label={t("dictation.downloadsLabel", "Downloads")}>
						{() => (
							<div class={d.assetList} data-speech-downloads>
								<For each={downloadRows()}>{(asset) => <SpeechAssetRow asset={asset} />}</For>
							</div>
						)}
					</SettingRow>
				</Show>
				<SettingRow label={t("dictation.speechLanguageLabel", "Replies are spoken in")}>
					{() => <span>{spokenLanguage()}</span>}
				</SettingRow>

				<ExpertSetting configKey="dictation.speech_engine" value={engine()}>
					<SettingRow
						label={t("dictation.speechEngineLabel", "Speech engine")}
						hint={t(
							"dictation.speechEngineHint",
							"Pocket TTS is the default and runs entirely on this machine after a download. An external command is your own engine.",
						)}
					>
						{(id, descriptionId) => (
							<>
								<Select
									data-setting-id="voice.speech_engine"
									id={id}
									aria-describedby={descriptionId()}
									value={engine()}
									onChange={(e) => void dictationStore.setSpeechEngine(e.currentTarget.value as SpeechEngineId)}
								>
									{/* The owner schema lists the engines; Microsoft Edge's online voices are retired. */}
									<For
										each={settingOptions("voice.speech_engine", {
											pocket: t("dictation.enginePocket", "Pocket TTS (local, downloads a model)"),
											external: t("dictation.engineExternal", "External command"),
										})}
									>
										{(option) => <option value={option.value}>{option.label}</option>}
									</For>
								</Select>
							</>
						)}
					</SettingRow>
				</ExpertSetting>

				<Show when={engine() === "external"}>
					<ExpertSetting configKey="dictation.speech_command" value={dictationStore.state.speechCommand}>
						<SettingRow
							label={t("dictation.speechCommandLabel", "Speech command")}
							hint={t(
								"dictation.speechCommandHint",
								"One argument per line, no shell. {out} is the WAV file the command must write; {text} and {voice} are optional (without {text}, the text arrives on stdin).",
							)}
						>
							{(id, descriptionId) => (
								<Textarea
									id={id}
									aria-describedby={descriptionId()}
									data-setting-id="voice.speech_command"
									rows={4}
									value={dictationStore.state.speechCommand.join("\n")}
									onChange={(e) =>
										void dictationStore.setSpeechCommand(
											e.currentTarget.value
												.split("\n")
												.map((line) => line.trim())
												.filter((line) => line !== ""),
										)
									}
								/>
							)}
						</SettingRow>
					</ExpertSetting>
				</Show>

				<Show when={hasVoicePicker()}>
					<SettingRow
						label={t("dictation.voiceLabel", "Voice")}
						hint={t(
							"dictation.voiceHint",
							"Changing the voice stops any reply already being spoken — a sentence half said in one voice does not finish in another.",
						)}
					>
						{(id, descriptionId) => (
							<>
								<div class={d.controlRow}>
									<Select
										data-setting-id="voice.speech_voice"
										id={id}
										aria-describedby={descriptionId()}
										value={dictationStore.state.speechVoice}
										onChange={(e) => dictationStore.setSpeechVoice(e.currentTarget.value)}
									>
										<option value="">{t("dictation.voiceDefault", "Default for this language")}</option>
										<For each={voiceChoices()}>
											{(voice) => (
												<option value={voice} selected={voice === dictationStore.state.speechVoice}>
													{voiceLabel(voice)}
												</option>
											)}
										</For>
									</Select>
									<Button
										variant="primary"
										data-non-setting="Preview audio or test recording without changing the stored preference"
										onClick={listen}
									>
										{t("dictation.listen", "Listen")}
									</Button>
								</div>
								<Show when={selectedMissingAsset()}>{(asset) => <SpeechAssetRow asset={asset()} />}</Show>
								<Show when={previewError()}>
									<p class={cx(s.hint, d.conversationError)}>{previewError()}</p>
								</Show>
							</>
						)}
					</SettingRow>
				</Show>

				<Show when={engine() === "pocket" && (languageAsset()?.voices.length ?? 0) > 0}>
					<SettingRow label={t("dictation.voicesLabel", "Voices")}>
						{() => <VoiceLibrary language={languageAsset()?.language ?? ""} />}
					</SettingRow>
				</Show>

				<ExpertSetting configKey="dictation.speech_volume_db" value={dictationStore.state.speechVolumeDb}>
					<SettingSlider
						settingId="voice.speech_volume_db"
						row
						label={t("dictation.voiceVolumeLabel", "Voice volume")}
						value={volumeDrag() ?? dictationStore.state.speechVolumeDb}
						onChange={setVolumeDrag}
						onCommit={(v) => {
							void dictationStore.setSpeechVolumeDb(v);
							setVolumeDrag(undefined);
						}}
						min={-30}
						max={-12}
						step={1}
						formatValue={(v) => `${v} dB`}
						hint={t(
							"dictation.voiceVolumeHint",
							"How loud every reply is spoken. Peaks are limited, so a high level never clips. Applies to the next reply.",
						)}
					/>
				</ExpertSetting>

				<ExpertSetting configKey="dictation.speech_levelling" value={dictationStore.state.speechLevelling}>
					<SettingSlider
						settingId="voice.speech_levelling"
						row
						label={t("dictation.levellingLabel", "Levelling")}
						value={levellingDrag() ?? Math.round(dictationStore.state.speechLevelling * 100)}
						onChange={setLevellingDrag}
						onCommit={(v) => {
							void dictationStore.setSpeechLevelling(v / 100);
							setLevellingDrag(undefined);
						}}
						min={0}
						max={100}
						step={1}
						formatValue={(v) =>
							v === 0
								? t("dictation.levellingOff", "Off")
								: v === 100
									? t("dictation.levellingStrong", "Strong")
									: `${v}%`
						}
						hint={t(
							"dictation.levellingHint",
							"Evens out quiet and loud words within a reply. Off keeps the voice as recorded.",
						)}
					/>
				</ExpertSetting>
			</SectionCard>
		</Show>
	);
};

/**
 * The voices of one language: catalogue voices already installed, catalogue
 * voices to download, and voice files the user imported. TUICommander does not
 * make voices; a user voice is a `.safetensors` file made elsewhere.
 */
const VoiceLibrary: Component<{ language: string }> = (props) => {
	const voiceAssets = (): SpeechAsset[] =>
		dictationStore.state.speechAssets.filter((asset) => asset.kind === "voice" && asset.language === props.language);
	const installed = () => voiceAssets().filter((asset) => asset.state === "ready");
	const downloadable = () => voiceAssets().filter((asset) => asset.state !== "ready");
	const userVoices = () => dictationStore.state.speechVoices.filter((voice) => voice.source === "user");

	const [importError, setImportError] = createSignal<string | null>(null);
	let fileInput: HTMLInputElement | undefined;
	const importFile = async (file: File | undefined) => {
		if (!file) return;
		setImportError(await dictationStore.importSpeechVoice(props.language, file));
		if (fileInput) fileInput.value = "";
	};

	return (
		<div class={cx(s.group, d.voiceLibrary)}>
			<Show when={installed().length > 0}>
				<div class={d.voiceGroup} data-voice-group="installed">
					<span class={d.voiceGroupTitle}>{t("dictation.voiceGroupInstalled", "Installed")}</span>
					<div class={d.assetList}>
						<For each={installed()}>{(asset) => <SpeechAssetRow asset={asset} />}</For>
					</div>
				</div>
			</Show>
			<Show when={downloadable().length > 0}>
				{/* Collapsed: a language offers two dozen voices, and listed open they
				    push the volume sliders out of sight. A native <summary> is
				    focusable and toggles on Enter and Space. */}
				<details class={d.voiceGroup} data-voice-group="downloadable">
					<summary class={cx(d.voiceGroupTitle, d.voiceGroupToggle)}>
						{t("dictation.voiceGroupDownloadable", "Downloadable")} ({downloadable().length})
					</summary>
					<div class={d.assetList}>
						<For each={downloadable()}>{(asset) => <SpeechAssetRow asset={asset} />}</For>
					</div>
				</details>
			</Show>
			<div class={d.voiceGroup} data-voice-group="yours">
				<span class={d.voiceGroupTitle}>{t("dictation.voiceGroupYours", "Yours")}</span>
				<Show when={userVoices().length > 0}>
					<div class={d.assetList}>
						<For each={userVoices()}>
							{(voice) => (
								<ListRow
									name={voice.id}
									badges={
										<Show when={voice.id === dictationStore.state.speechVoice}>
											<StatusBadge label={t("dictation.active", "Active")} variant="success" />
										</Show>
									}
									actions={
										<Button
											data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
											onClick={() => dictationStore.deleteSpeechVoice(props.language, voice.id)}
											title={t("dictation.voiceDeleteUser", "Delete this voice file")}
										>
											{t("dictation.removeModel", "Remove")}
										</Button>
									}
								/>
							)}
						</For>
					</div>
				</Show>
				<div class={d.controlRow}>
					<Button
						variant="primary"
						data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
						onClick={() => fileInput?.click()}
					>
						{t("dictation.addVoiceFile", "Add voice file…")}
					</Button>
					<input
						data-non-setting="Speech asset file import, not persisted configuration"
						ref={fileInput}
						type="file"
						accept=".safetensors"
						hidden
						onChange={(e) => void importFile(e.currentTarget.files?.[0])}
					/>
				</div>
				<Show when={importError()}>
					<p class={cx(s.hint, d.conversationError)}>{importError()}</p>
				</Show>
			</div>
			<p class={s.hint}>
				{t(
					"dictation.voicesHint",
					"Each voice is a separate download. A voice file you add must be made for this language's model (.safetensors); FastAF does not create voices.",
				)}
			</p>
		</div>
	);
};

/** One catalogue entry: what it is, what state it is in, and what to do next. */
const SpeechAssetRow: Component<{ asset: SpeechAsset }> = (props) => {
	const percent = () => dictationStore.state.speechDownloads[props.asset.id];
	const downloading = () => props.asset.state === "downloading" || percent() !== undefined;
	// The bundle replies are spoken with — the counterpart of the selected
	// Whisper model, and marked with the same shared badge.
	const speaking = () =>
		props.asset.state === "ready" &&
		(props.asset.kind === "voice"
			? props.asset.voice === dictationStore.state.speechVoice
			: props.asset.language !== null && props.asset.language === dictationStore.state.language);

	return (
		<div class={d.assetRow}>
			<ListRow
				name={props.asset.display_name}
				description={megabytes(props.asset.download_bytes)}
				badges={
					<>
						<Show when={!downloading()}>
							<StatusBadge
								label={
									props.asset.state === "ready"
										? t("dictation.downloaded", "Downloaded")
										: props.asset.state === "incomplete"
											? t("dictation.speechIncomplete", "Incomplete")
											: t("dictation.notDownloaded", "Not downloaded")
								}
							/>
						</Show>
						<Show when={!downloading() && speaking()}>
							<StatusBadge label={t("dictation.active", "Active")} variant="success" />
						</Show>
					</>
				}
				actions={
					<>
						<Show when={downloading()}>
							<AssetDownloadProgress percent={percent() ?? 0} />
							<Button
								data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
								onClick={() => dictationStore.cancelSpeechDownload(props.asset.id)}
								title={t("dictation.cancel", "Cancel")}
							>
								{t("dictation.cancel", "Cancel")}
							</Button>
						</Show>
						<Show when={!downloading() && props.asset.state !== "ready"}>
							<Button
								data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
								onClick={() => dictationStore.downloadSpeechAsset(props.asset.id)}
							>
								{props.asset.state === "incomplete"
									? t("dictation.speechRepair", "Repair")
									: t("dictation.download", "Download")}
							</Button>
						</Show>
						<Show when={!downloading() && props.asset.state !== "absent"}>
							<Button
								data-non-setting="Voice asset install, removal or download workflow; not an editable preference"
								onClick={() => dictationStore.deleteSpeechAsset(props.asset.id)}
								title={t("dictation.speechDelete", "Delete this download")}
							>
								{t("dictation.removeModel", "Remove")}
							</Button>
						</Show>
					</>
				}
			/>
		</div>
	);
};

/**
 * Starting, watching and stopping a hands-free conversation.
 *
 * Nothing here arms on mount. Opening this panel must never open the
 * microphone, and neither must starting the app: a conversation begins because
 * somebody pressed Start, and ends because somebody pressed Stop, pressed the
 * dictation hotkey, or closed the terminal it was bound to.
 *
 * Every decision below belongs to Rust — when an utterance ends, whether the
 * activation phrase opened it, when the hold-back expires, what may be spoken.
 * This renders the answers and offers the two buttons.
 *
 * Browser-only in FastAF. On the desktop the hands-free mode is FastAF's own
 * voice agent (Settings › Voice), so this card is not rendered there and a
 * second, parallel conversation system is never offered. A browser tab arms
 * under its own owner name and holds the conversation through its own
 * microphone and speaker; which hardware the store opens is decided in
 * `dictation.ts armHandsFree` rather than in a control.
 */
const HandsFreeControls: Component = () => {
	const [chats, setChats] = createSignal<ChatVoiceTarget[]>([]);
	const refreshChats = () =>
		chatVoiceTargets()
			.then(setChats)
			.catch(() => {});
	const [target, setTarget] = createSignal(terminalsStore.getActive()?.sessionId ?? "");
	// Rust owns the built-in notice; it is only shown here as the placeholder.
	const [defaultNotice, setDefaultNotice] = createSignal("");

	// Polled rather than pushed: hands-free state has no SSE arm yet, and a
	// panel that shows a stale phase is worse than one that lags a beat. Only
	// while this panel is open — see `onCleanup`.
	let timer: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		dictationStore
			.getDefaultHandsFreeStartNotice()
			.then(setDefaultNotice)
			.catch(() => appLogger.warn("dictation", "Failed to load the default hands-free start notice"));
		void refreshChats();
		dictationStore.refreshHandsFree();
		dictationStore.refreshSpeechStatus();
		timer = setInterval(() => {
			void refreshChats();
			dictationStore.refreshHandsFree();
			dictationStore.refreshSpeechStatus();
		}, 500);
	});
	onCleanup(() => {
		if (timer) clearInterval(timer);
	});

	const status = () => dictationStore.state.handsFree;
	const speech = () => dictationStore.state.speech;
	const armed = () => status()?.armed === true;

	/** Terminals that have a live PTY session, which is what can be bound. */
	const targets = () =>
		terminalsStore
			.getIds()
			.map((id) => terminalsStore.get(id))
			.filter((term): term is NonNullable<typeof term> => !!term?.sessionId);

	const phaseLabel = (): string => handsFreePhaseLabel(status()?.phase);

	/** What the speaker is doing, or empty when it is doing nothing. */
	const speakingLabel = (): string => {
		const current = speech();
		if (!current) return "";
		if (current.speaking) return t("dictation.speechPlaying", "Playing a reply");
		if (current.rendering) return t("dictation.speechRendering", "Synthesising a reply");
		if (current.queued > 0)
			return t("dictation.speechQueued", "{n} replies waiting").replace("{n}", String(current.queued));
		return "";
	};

	const start = async () => {
		const sessionId = target();
		if (!sessionId) return;
		await dictationStore.armHandsFree(sessionId);
	};

	return (
		<Show when={!isTauri()}>
			<SectionCard title={t("dictation.heading.handsFree", "Hands-free conversation")}>
				<p class={cx(s.hint, d.intro)}>
					{t(
						"dictation.handsFreeHint",
						"Push-to-talk is the hotkey above: hold it, speak, release. Hands-free binds one terminal or AI Chat, keeps the microphone open and sends each utterance by itself. Use {hotkey} to start or stop hands-free on the active terminal.",
						{ hotkey: keyFor("toggle-hands-free") || t("dictation.handsFreePaletteFallback", "the Command Palette") },
					)}
				</p>

				<div class={s.group}>
					<SettingRow label="Target">
						{(id, descriptionId) => (
							<div class={s.passwordRow}>
								<Select
									data-non-setting="Current hands-free conversation target, not persisted configuration"
									id={id}
									aria-describedby={descriptionId()}
									value={armed() ? (status()?.sessionId ?? target()) : target()}
									onChange={(e) => {
										setTarget(e.currentTarget.value);
										if (armed()) void dictationStore.disarmHandsFree();
									}}
								>
									<option value="">{t("dictation.handsFreeNoTarget", "Choose a terminal or AI Chat…")}</option>
									<For each={targets()}>{(term) => <option value={term.sessionId ?? ""}>{term.name}</option>}</For>
									<For each={chats()}>{(chat) => <option value={chat.id}>{chat.name}</option>}</For>
								</Select>
								<Show
									when={armed()}
									fallback={
										<Button
											variant="primary"
											data-non-setting="Start or stop the current hands-free runtime conversation"
											onClick={start}
											disabled={!target()}
										>
											{t("dictation.handsFreeStart", "Start conversation")}
										</Button>
									}
								>
									<Button
										variant="danger"
										data-non-setting="Start or stop the current hands-free runtime conversation"
										onClick={() => dictationStore.disarmHandsFree()}
									>
										{t("dictation.handsFreeStop", "Stop conversation")}
									</Button>
								</Show>
							</div>
						)}
					</SettingRow>

					<StatusSummary
						label={armed() ? t("dictation.handsFreeRunning", "Running") : t("dictation.handsFreeStopped", "Stopped")}
						tone={status()?.phase === "error" ? "error" : armed() ? "success" : undefined}
						source={
							status() &&
							phaseLabel() !==
								(armed() ? t("dictation.handsFreeRunning", "Running") : t("dictation.handsFreeStopped", "Stopped"))
								? phaseLabel()
								: "Hands-free conversation"
						}
					/>

					<Show when={status()}>
						{(current) => (
							<>
								<Show when={current().sessionId}>
									<ListRow
										name={t("dictation.handsFreeTarget", "Bound target")}
										description={String(
											chats().find((chat) => chat.id === current().sessionId)?.name ??
												terminalsStore.get(terminalsStore.getTerminalForSession(current().sessionId ?? "") ?? "")
													?.name ??
												current().sessionId,
										)}
									/>
								</Show>
								<Show when={current().owner}>
									<ListRow name={t("dictation.handsFreeOwner", "Audio from")} description={String(current().owner)} />
								</Show>
								<Show when={speakingLabel()}>
									<ListRow name={t("dictation.handsFreeSpeaker", "Speaker")} description={String(speakingLabel())} />
								</Show>
								<Show when={current().armed && speech() && !speech()?.available}>
									<ListRow
										name={t("dictation.handsFreeNoVoice", "Cannot speak")}
										description={String(speech()?.unavailableReason)}
									/>
								</Show>
								<Show when={current().pendingText}>
									<p class={d.conversationPending}>
										{t("dictation.handsFreePending", "About to send")}: {current().pendingText}
									</p>
								</Show>
								<Show when={current().error ?? dictationStore.state.handsFreeError}>
									<p class={d.conversationError}>{current().error ?? dictationStore.state.handsFreeError}</p>
								</Show>
							</>
						)}
					</Show>
				</div>

				<SettingRow
					label={t("dictation.activationPhraseLabel", "Activation phrase")}
					hint={t(
						"dictation.activationPhraseHint",
						"When set, only speech that opens with this phrase is sent, and the phrase itself is removed first. The match runs on this machine, so unrelated speech never leaves it. Try “computer”. Leave empty to send every utterance.",
					)}
				>
					{(id, descriptionId) => (
						<>
							<Input
								data-setting-id="voice.hands_free_activation_phrase"
								id={id}
								aria-describedby={descriptionId()}
								type="text"
								value={dictationStore.state.handsFreeActivationPhrase}
								placeholder={t("dictation.activationPhrasePlaceholder", "computer")}
								onChange={(e) => dictationStore.setHandsFreeActivationPhrase(e.currentTarget.value)}
							/>
						</>
					)}
				</SettingRow>

				<ExpertSetting configKey="dictation.hands_free_hold_back_ms" value={dictationStore.state.handsFreeHoldBackMs}>
					<SettingSlider
						settingId="voice.hands_free_hold_back_ms"
						row
						label={t("dictation.holdBackLabel", "Hold-back before sending")}
						value={dictationStore.state.handsFreeHoldBackMs}
						onChange={(v) => dictationStore.setHandsFreeHoldBackMs(v)}
						min={0}
						max={5000}
						step={250}
						formatValue={(v) => (v === 0 ? t("dictation.instant", "Instant") : `${v}ms`)}
						hint={t(
							"dictation.holdBackHint",
							"How long a finished utterance is shown before it is sent, so you can stop one you did not mean. Applies to the next conversation, not the one already running.",
						)}
					/>
				</ExpertSetting>

				<SettingToggle
					settingId="voice.hands_free_listening"
					row
					label={t("dictation.handsFreeListeningLabel", "Hands-free listening")}
					hint={t(
						"dictation.handsFreeListeningHint",
						"Keep the microphone open and send each utterance by itself. Turn off to dictate with push-to-talk only; with spoken replies on, the agent still answers out loud. Applies to the next conversation.",
					)}
					checked={dictationStore.state.handsFreeListening}
					onChange={(checked) => dictationStore.setHandsFreeListening(checked)}
				/>

				<SettingToggle
					settingId="voice.hands_free_spoken_replies"
					row
					label={t("dictation.spokenRepliesLabel", "Spoken replies")}
					hint={t(
						"dictation.spokenRepliesHint",
						"Let the agent answer out loud. Turn off to keep dictation and receive text replies.",
					)}
					checked={dictationStore.state.spokenReplies}
					onChange={(checked) => dictationStore.setSpokenReplies(checked)}
				/>

				<SettingToggle
					settingId="voice.hands_free_earcons"
					row
					label={t("dictation.earconsLabel", "Earcons")}
					hint={t(
						"dictation.earconsHint",
						"Play a short sound when a turn is sent to the agent, and a lower one when a turn without the activation phrase is dropped. Only the device you talk into plays them.",
					)}
					checked={dictationStore.state.handsFreeEarcons}
					onChange={(checked) => dictationStore.setHandsFreeEarcons(checked)}
				/>

				<ExpertSetting
					configKey="dictation.hands_free_notify_model"
					value={dictationStore.state.notifyModelOnHandsFree}
				>
					<SettingToggle
						settingId="voice.hands_free_notify_model"
						row
						label={t("dictation.notifyModelLabel", "Notify model when hands-free changes")}
						hint={t(
							"dictation.notifyModelHint",
							"Tell the agent when a hands-free conversation starts, so it answers out loud, and when it ends, so it goes back to text. Turning this off never leaves speech running: disarming always stops it.",
						)}
						checked={dictationStore.state.notifyModelOnHandsFree}
						onChange={(checked) => dictationStore.setNotifyModelOnHandsFree(checked)}
					/>
				</ExpertSetting>

				{/* The notice is only sent while the toggle above is on. */}
				<Show when={dictationStore.state.notifyModelOnHandsFree}>
					<ExpertSetting
						configKey="dictation.hands_free_start_notice"
						value={dictationStore.state.handsFreeStartNotice}
					>
						<SettingRow
							label={t("dictation.startNoticeLabel", "Start notice")}
							hint={t(
								"dictation.startNoticeHint",
								"What the agent reads when a conversation starts. Leave it empty to send the built-in text shown in grey.",
							)}
						>
							{(id, descriptionId) => (
								<div>
									<Textarea
										data-setting-id="voice.hands_free_start_notice"
										id={id}
										aria-describedby={descriptionId()}
										value={dictationStore.state.handsFreeStartNotice}
										placeholder={defaultNotice()}
										onChange={(e) => dictationStore.setHandsFreeStartNotice(e.currentTarget.value)}
									/>
									<div class={cx(d.controlRow, d.spacedControlRow)}>
										<Button
											data-setting-id="voice.hands_free_start_notice"
											class={s.testBtn}
											onClick={() => {
												// A click is not an input/change event: pin here so the reset does not hide the control.
												settingsExpertStore.pin("dictation.hands_free_start_notice");
												dictationStore.resetHandsFreeStartNotice();
											}}
											disabled={!dictationStore.state.handsFreeStartNotice}
										>
											{t("dictation.startNoticeReset", "Reset to default")}
										</Button>
									</div>
								</div>
							)}
						</SettingRow>
					</ExpertSetting>
				</Show>
			</SectionCard>
		</Show>
	);
};
