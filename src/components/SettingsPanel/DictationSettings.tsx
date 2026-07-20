import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import type { ModelInfo } from "../../stores/dictation";
import { dictationStore, WHISPER_LANGUAGES } from "../../stores/dictation";
import { cx } from "../../utils";
import { KeyComboCapture } from "../shared/KeyComboCapture";
import d from "./DictationSettings.module.css";
import { SettingSlider } from "./SettingFields";
import s from "./Settings.module.css";

/** Single model row in the model selector list */
const ModelRow: Component<{ model: ModelInfo }> = (props) => {
	const isSelected = () => dictationStore.state.selectedModel === props.model.name;
	const isDownloading = () =>
		dictationStore.state.downloading && dictationStore.state.selectedModel === props.model.name;

	const sizeLabel = () =>
		props.model.downloaded && props.model.actual_size_mb > 0
			? `${props.model.actual_size_mb} MB`
			: `~${props.model.size_hint_mb} MB`;

	return (
		<div class={cx(d.modelRow, isSelected() && d.active)}>
			<div class={d.modelInfo}>
				<span class={d.modelName}>{props.model.display_name}</span>
				<span class={d.modelSize}>{sizeLabel()}</span>
			</div>
			<Show when={!isDownloading()}>
				<span class={cx(d.modelBadge, props.model.downloaded && d.downloaded)}>
					{props.model.downloaded
						? t("dictation.downloaded", "Downloaded")
						: t("dictation.notDownloaded", "Not Downloaded")}
				</span>
			</Show>
			<div class={d.modelActions}>
				<Show when={props.model.downloaded && !isSelected()}>
					<button class={d.modelSelect} onClick={() => dictationStore.setModel(props.model.name)}>
						{t("dictation.use", "Use")}
					</button>
				</Show>
				<Show when={props.model.downloaded && isSelected()}>
					<span class={d.modelActiveLabel}>{t("dictation.active", "Active")}</span>
				</Show>
				<Show when={!props.model.downloaded && !isDownloading()}>
					<button class={d.modelDownload} onClick={() => dictationStore.downloadModel(props.model.name)}>
						{t("dictation.download", "Download")}
					</button>
				</Show>
				<Show when={isDownloading()}>
					<div class={d.downloadProgress}>
						<div class={d.progressBar}>
							<div
								class={d.progressFill}
								style={{ transform: `scaleX(${dictationStore.state.downloadPercent / 100})` }}
							/>
						</div>
						<span class={d.progressText}>{dictationStore.state.downloadPercent}%</span>
					</div>
				</Show>
				<Show when={props.model.downloaded}>
					<button
						class={d.modelDelete}
						onClick={() => dictationStore.deleteModel(props.model.name)}
						title={t("dictation.deleteModel", "Delete model")}
					>
						&times;
					</button>
				</Show>
			</div>
		</div>
	);
};

/** Dictation settings tab for the Settings panel */
export const DictationSettings: Component = () => {
	const [newFrom, setNewFrom] = createSignal("");
	const [newTo, setNewTo] = createSignal("");
	const [rewriteKeyInput, setRewriteKeyInput] = createSignal("");
	const [rewriteKeyMsg, setRewriteKeyMsg] = createSignal("");
	const [savingRewriteKey, setSavingRewriteKey] = createSignal(false);
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
		dictationStore.refreshRewriteKeyExists();
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
	const sttModel = () => {
		switch (sttProvider()) {
			case "groq":
				return dictationStore.state.sttModelGroq;
			case "custom":
				return dictationStore.state.sttModelCustom;
			default:
				return dictationStore.state.sttModelOpenai;
		}
	};

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

	/** Model dropdown options — the saved model is appended if absent from the fetch */
	const rewriteModelOptions = () => {
		const models = dictationStore.state.rewriteModels;
		const saved = dictationStore.state.rewriteModel;
		if (saved && !models.some((m) => m.id === saved)) {
			return [...models, { id: saved, supports_reasoning: false, effort_options: null, default_effort: null }];
		}
		return models;
	};

	const selectedRewriteModel = () =>
		dictationStore.state.rewriteModels.find((m) => m.id === dictationStore.state.rewriteModel);

	/** OpenAI-spec vocabulary as fallback when reasoning is advertised without an enumeration */
	const effortOptions = () => selectedRewriteModel()?.effort_options ?? ["minimal", "low", "medium", "high"];

	const handleSaveRewriteKey = async () => {
		if (!rewriteKeyInput().trim()) return;
		setSavingRewriteKey(true);
		setRewriteKeyMsg("");
		try {
			await dictationStore.saveRewriteApiKey(rewriteKeyInput().trim());
			setRewriteKeyInput("");
			setRewriteKeyMsg(t("dictation.rewriteKeySaved", "Key saved"));
		} catch (e) {
			setRewriteKeyMsg(`Error: ${String(e)}`);
		} finally {
			setSavingRewriteKey(false);
		}
	};

	const handleDeleteRewriteKey = async () => {
		setSavingRewriteKey(true);
		try {
			await dictationStore.deleteRewriteApiKey();
			setRewriteKeyMsg(t("dictation.rewriteKeyRemoved", "Key removed"));
		} catch (e) {
			setRewriteKeyMsg(`Error: ${String(e)}`);
		} finally {
			setSavingRewriteKey(false);
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

	return (
		<div class={s.section}>
			<h3>{t("dictation.title", "Dictation Settings")}</h3>

			{/* Enable toggle */}
			<div class={s.group}>
				<label>{t("dictation.enableLabel", "Enable Dictation")}</label>
				<div class={s.toggle}>
					<input
						type="checkbox"
						checked={dictationStore.state.enabled}
						onChange={(e) => dictationStore.setEnabled(e.currentTarget.checked)}
					/>
					<span>{t("dictation.enableHint", "Enable voice-to-text dictation")}</span>
				</div>
			</div>

			{/* Speech-to-text provider */}
			<div class={s.group}>
				<label>{t("dictation.sttProviderLabel", "Speech-to-Text Provider")}</label>
				<select value={sttProvider()} onChange={(e) => handleSttProviderChange(e.currentTarget.value)}>
					<option value="local">{t("dictation.sttProviderLocal", "Local — whisper.cpp (on-device)")}</option>
					<option value="groq">{t("dictation.sttProviderGroq", "Groq Cloud")}</option>
					<option value="openai">{t("dictation.sttProviderOpenai", "OpenAI")}</option>
					<option value="custom">{t("dictation.sttProviderCustom", "Custom — OpenAI-compatible URL")}</option>
				</select>
				<Show when={sttProvider() === "custom"}>
					<div style={{ "margin-top": "8px" }}>
						<label>{t("dictation.sttBaseUrlLabel", "Base URL")}</label>
						<input
							class={s.input}
							type="text"
							placeholder="http://127.0.0.1:8000/v1"
							value={dictationStore.state.sttBaseUrl}
							onChange={(e) => dictationStore.saveConfig({ stt_base_url: e.currentTarget.value.trim() })}
						/>
						<p class={s.hint}>
							{t(
								"dictation.sttBaseUrlHint",
								"Any OpenAI-compatible /audio/transcriptions server (same idea as the rewrite base URL). API key below is optional for local servers.",
							)}
						</p>
					</div>
				</Show>
				<Show when={sttProvider() !== "local"}>
					{/* API key (required for cloud providers, optional for custom) */}
					<div style={{ "margin-top": "8px" }}>
						<div class={s.passwordRow}>
							<input
								class={s.input}
								type="password"
								placeholder={
									sttKeyExists()
										? t("dictation.sttKeyReplace", "Replace existing key…")
										: t("dictation.sttKeyEnter", "Enter API key…")
								}
								value={sttKeyInput()}
								onInput={(e) => setSttKeyInput(e.currentTarget.value)}
							/>
							<button class={s.saveBtn} onClick={handleSaveSttKey} disabled={savingSttKey() || !sttKeyInput().trim()}>
								{t("dictation.sttKeySave", "Save")}
							</button>
							<Show when={sttKeyExists()}>
								<button
									class={s.testBtn}
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

			{/* Model selector (local whisper only) */}
			<Show when={sttProvider() === "local"}>
				<div class={s.group}>
					<label>{t("dictation.modelLabel", "Whisper Model")}</label>
					<p class={s.hint} style={{ "margin-bottom": "8px" }}>
						{t("dictation.modelHint", "Choose a model. Larger models are more accurate but slower.")}
					</p>
					<div class={d.modelList}>
						<For each={dictationStore.state.models}>{(model: ModelInfo) => <ModelRow model={model} />}</For>
					</div>
				</div>
			</Show>

			{/* Hotkey */}
			<div class={s.group}>
				<label>{t("dictation.hotkeyLabel", "Hotkey")}</label>
				<div class={d.hotkeyRow}>
					<KeyComboCapture
						value={dictationStore.state.hotkey}
						onChange={(combo) => dictationStore.setHotkey(combo)}
						placeholder={t("dictation.hotkeyPlaceholder", "Press a key combination...")}
						onCapturingChange={(capturing) => dictationStore.setCapturingHotkey(capturing)}
					/>
				</div>
				<p class={s.hint}>
					{t(
						"dictation.hotkeyHint",
						"Hold the hotkey to start recording, release to stop. Short presses pass through as normal input.",
					)}
				</p>
			</div>

			{/* Long-press threshold */}
			<SettingSlider
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

			{/* Auto-send */}
			<div class={s.group}>
				<label>{t("dictation.autoSendLabel", "Auto-send")}</label>
				<div class={s.toggle}>
					<input
						type="checkbox"
						checked={dictationStore.state.autoSend}
						onChange={(e) => dictationStore.setAutoSend(e.currentTarget.checked)}
					/>
					<span>{t("dictation.autoSendHint", "Automatically press Enter after inserting transcribed text")}</span>
				</div>
			</div>

			{/* AI Rewrite */}
			<div class={s.group}>
				<label>{t("dictation.rewriteLabel", "AI Rewrite")}</label>
				<div class={s.toggle}>
					<input
						type="checkbox"
						checked={dictationStore.state.rewriteEnabled}
						onChange={(e) => dictationStore.setRewriteEnabled(e.currentTarget.checked)}
					/>
					<span>{t("dictation.rewriteHint", "Rewrite transcripts with an AI model before inserting them")}</span>
				</div>
				<Show when={dictationStore.state.rewriteEnabled}>
					{/* Base URL */}
					<div style={{ "margin-top": "8px" }}>
						<input
							type="text"
							placeholder="https://openrouter.ai/api/v1"
							value={dictationStore.state.rewriteBaseUrl}
							onChange={(e) => dictationStore.setRewriteBaseUrl(e.currentTarget.value.trim())}
						/>
						<p class={s.hint}>
							{t(
								"dictation.rewriteBaseUrlHint",
								"Any OpenAI-compatible endpoint — e.g. Ollama at http://localhost:11434/v1",
							)}
						</p>
					</div>

					{/* API key (optional) */}
					<div style={{ "margin-top": "8px" }}>
						<div class={s.passwordRow}>
							<input
								class={s.input}
								type="password"
								placeholder={
									dictationStore.state.rewriteKeyExists
										? t("dictation.rewriteKeyReplace", "Replace existing key…")
										: t("dictation.rewriteKeyEnter", "Enter API key…")
								}
								value={rewriteKeyInput()}
								onInput={(e) => setRewriteKeyInput(e.currentTarget.value)}
							/>
							<button
								class={s.saveBtn}
								onClick={handleSaveRewriteKey}
								disabled={savingRewriteKey() || !rewriteKeyInput().trim()}
							>
								{t("dictation.rewriteKeySave", "Save")}
							</button>
							<Show when={dictationStore.state.rewriteKeyExists}>
								<button
									class={s.testBtn}
									onClick={handleDeleteRewriteKey}
									disabled={savingRewriteKey()}
									style={{ color: "var(--error)" }}
								>
									{t("dictation.rewriteKeyRemove", "Remove")}
								</button>
							</Show>
						</div>
						<p class={s.hint}>
							{t("dictation.rewriteKeyHint", "API key is optional for local endpoints (Ollama, LM Studio).")}
						</p>
						<Show when={rewriteKeyMsg()}>
							<div class={s.hint}>{rewriteKeyMsg()}</div>
						</Show>
					</div>

					{/* Model */}
					<div style={{ "margin-top": "8px" }}>
						<button
							class={s.inlineBtn}
							onClick={() => dictationStore.fetchRewriteModels()}
							disabled={dictationStore.state.fetchingRewriteModels || !dictationStore.state.rewriteBaseUrl.trim()}
						>
							{dictationStore.state.fetchingRewriteModels
								? t("dictation.rewriteFetchingModels", "Fetching…")
								: t("dictation.rewriteFetchModels", "Fetch models")}
						</button>
						<Show when={dictationStore.state.rewriteModelsError}>
							<p class={s.hint} style={{ color: "var(--error)" }}>
								{dictationStore.state.rewriteModelsError}
							</p>
						</Show>
						<Show when={rewriteModelOptions().length > 0}>
							<select
								value={dictationStore.state.rewriteModel}
								onChange={(e) => dictationStore.setRewriteModel(e.currentTarget.value)}
								style={{ "margin-top": "6px" }}
							>
								<option value="">{t("dictation.rewriteModelNone", "Select a model…")}</option>
								<For each={rewriteModelOptions()}>{(model) => <option value={model.id}>{model.id}</option>}</For>
							</select>
						</Show>
					</div>

					{/* Reasoning effort — only when the selected model advertises reasoning */}
					<Show when={selectedRewriteModel()?.supports_reasoning}>
						<div style={{ "margin-top": "8px" }}>
							<label>{t("dictation.rewriteEffortLabel", "Reasoning effort")}</label>
							<select
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
						</div>
					</Show>

					{/* System prompt */}
					<div style={{ "margin-top": "8px" }}>
						<label>{t("dictation.rewritePromptLabel", "System prompt")}</label>
						<textarea
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
				</Show>
			</div>

			{/* Language */}
			<div class={s.group}>
				<label>{t("dictation.languageLabel", "Language")}</label>
				<select
					value={dictationStore.state.language}
					onChange={(e) => dictationStore.setLanguage(e.currentTarget.value)}
				>
					<For each={Object.entries(WHISPER_LANGUAGES)}>
						{([value, label]) => <option value={value}>{label}</option>}
					</For>
				</select>
				<p class={s.hint}>{t("dictation.languageHint", "Auto-detect works well for most languages.")}</p>
			</div>

			{/* Audio devices */}
			<div class={s.group}>
				<label>{t("dictation.microphoneLabel", "Microphone")}</label>
				<Show
					when={dictationStore.state.devices.length > 0}
					fallback={
						<div>
							<button
								class={s.downloadBtn}
								onClick={() => dictationStore.refreshDevices()}
								style={{
									background: "var(--bg-tertiary)",
									color: "var(--fg-secondary)",
									border: "1px solid var(--border)",
								}}
							>
								{t("dictation.detectMicrophones", "Detect Microphones")}
							</button>
							<p class={s.hint}>
								{t("dictation.detectMicrophonesHint", "Triggers macOS microphone permission dialog.")}
							</p>
						</div>
					}
				>
					<select
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
					</select>
					<p class={s.hint}>{t("dictation.microphoneHint", "Select the input device to use for dictation.")}</p>
				</Show>
			</div>

			{/* Correction map */}
			<div class={s.group}>
				<label>{t("dictation.correctionsLabel", "Auto-Corrections")}</label>
				<p class={s.hint} style={{ "margin-bottom": "8px" }}>
					{t("dictation.correctionsHint", "Automatically replace dictation output. Useful for technical terms.")}
				</p>

				{/* Existing corrections */}
				<Show when={Object.keys(dictationStore.state.corrections).length > 0}>
					<div class={d.correctionsTable}>
						<div class={d.correctionsHeader}>
							<span>{t("dictation.correctionsFrom", "From")}</span>
							<span>{t("dictation.correctionsTo", "To")}</span>
							<span />
						</div>
						<For each={Object.entries(dictationStore.state.corrections)}>
							{([from, to]) => (
								<div class={d.correctionsRow}>
									<span class={d.correctionText}>{from}</span>
									<span class={d.correctionText}>{to}</span>
									<button
										class={d.correctionDelete}
										onClick={() => handleRemoveCorrection(from)}
										title={t("dictation.removeCorrection", "Remove correction")}
									>
										&times;
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>

				{/* Add new correction */}
				<div class={d.correctionAdd}>
					<input
						type="text"
						placeholder={t("dictation.correctionFromPlaceholder", "Heard text...")}
						value={newFrom()}
						onInput={(e) => setNewFrom(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "Enter" && handleAddCorrection()}
					/>
					<span class={d.correctionArrow}>&rarr;</span>
					<input
						type="text"
						placeholder={t("dictation.correctionToPlaceholder", "Replace with...")}
						value={newTo()}
						onInput={(e) => setNewTo(e.currentTarget.value)}
						onKeyDown={(e) => e.key === "Enter" && handleAddCorrection()}
					/>
					<button
						class={d.correctionAddBtn}
						onClick={handleAddCorrection}
						disabled={!newFrom().trim() || !newTo().trim()}
					>
						{t("dictation.addCorrection", "Add")}
					</button>
				</div>

				{/* Import/Export */}
				<div class={s.actions} style={{ "margin-top": "8px" }}>
					<button onClick={handleImportCorrections}>{t("dictation.import", "Import")}</button>
					<button onClick={handleExportCorrections}>{t("dictation.export", "Export")}</button>
				</div>
			</div>
		</div>
	);
};
