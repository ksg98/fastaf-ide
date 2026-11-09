import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { type VoiceInfo, type VoiceModelInfo, voiceStore } from "../../../stores/voice";
import { cx } from "../../../utils";
import { ConfirmDialog } from "../../ConfirmDialog/ConfirmDialog";
import d from "../DictationSettings.module.css";
import { SettingSelect, SettingSlider, SettingToggle } from "../SettingFields";
import s from "../Settings.module.css";
import { SectionCard, SettingPageHeader } from "../SettingsPrimitives";

/** Inline progress bar, shown on whichever row is downloading. */
const DownloadBar: Component = () => (
	<div class={d.downloadProgress}>
		<div class={d.progressBar}>
			<div class={d.progressFill} style={{ transform: `scaleX(${voiceStore.state.downloadPercent / 100})` }} />
		</div>
		<span class={d.progressText}>{voiceStore.state.downloadPercent}%</span>
	</div>
);

/** One Kokoro graph: size, download state, and the actions for it. */
const ModelRow: Component<{ model: VoiceModelInfo }> = (props) => {
	const [confirmDelete, setConfirmDelete] = createSignal(false);
	const isSelected = () => voiceStore.state.config.model === props.model.name;
	const isDownloading = () => voiceStore.state.downloading === props.model.name;
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
					{props.model.downloaded ? "Downloaded" : "Not downloaded"}
				</span>
			</Show>
			<div class={d.modelActions}>
				<Show when={props.model.downloaded && !isSelected()}>
					<button
						data-setting-exclusion="fastaf.voice_agent"
						class={d.modelSelect}
						onClick={() => voiceStore.saveConfig({ model: props.model.name })}
					>
						Use
					</button>
				</Show>
				<Show when={props.model.downloaded && isSelected()}>
					<span class={d.modelActiveLabel}>Active</span>
				</Show>
				<Show when={!props.model.downloaded && !isDownloading()}>
					<button
						data-setting-exclusion="fastaf.voice_agent"
						class={d.modelDownload}
						onClick={() => voiceStore.downloadModel(props.model.name)}
					>
						Download
					</button>
				</Show>
				<Show when={isDownloading()}>
					<DownloadBar />
				</Show>
				<Show when={props.model.downloaded}>
					<button
						data-setting-exclusion="fastaf.voice_agent"
						class={d.modelDelete}
						onClick={() => setConfirmDelete(true)}
						title="Delete download"
					>
						&times;
					</button>
				</Show>
			</div>
			<ConfirmDialog
				visible={confirmDelete()}
				title="Delete model?"
				message={`${props.model.display_name} (${sizeLabel()}) will be removed from this Mac. Using it again means downloading it again.`}
				confirmLabel="Delete"
				kind="warning"
				defaultButton="cancel"
				onClose={() => setConfirmDelete(false)}
				onConfirm={() => {
					setConfirmDelete(false);
					void voiceStore.deleteModel(props.model.name);
				}}
			/>
		</div>
	);
};

/** One voice. Each is a separate 0.5 MB style table. */
const VoiceRow: Component<{ voice: VoiceInfo }> = (props) => {
	const isSelected = () => voiceStore.state.config.voice === props.voice.id;
	const isDownloading = () => voiceStore.state.downloading === props.voice.id;

	// Selecting an undownloaded voice fetches it first, so one click is enough.
	const use = async () => {
		if (!props.voice.downloaded) await voiceStore.downloadVoice(props.voice.id);
		await voiceStore.saveConfig({ voice: props.voice.id });
	};

	return (
		<div class={cx(d.modelRow, isSelected() && d.active)}>
			<div class={d.modelInfo}>
				<span class={d.modelName}>{props.voice.display_name}</span>
				<span class={d.modelSize}>0.5 MB</span>
			</div>
			<div class={d.modelActions}>
				<Show when={isDownloading()}>
					<DownloadBar />
				</Show>
				<Show when={!isDownloading() && !(isSelected() && props.voice.downloaded)}>
					<button data-setting-exclusion="fastaf.voice_agent" class={d.modelSelect} onClick={() => void use()}>
						{props.voice.downloaded ? "Use" : "Get & use"}
					</button>
				</Show>
				{/* Selected is not enough — the default voice is selected out of
				    the box with nothing on disk, and labelling that Active reads
				    as a working setup right up until Load fails (#6). */}
				<Show when={isSelected() && props.voice.downloaded}>
					<span class={d.modelActiveLabel}>Active</span>
				</Show>
				<Show when={props.voice.downloaded && !isSelected()}>
					<button
						data-setting-exclusion="fastaf.voice_agent"
						class={d.modelDelete}
						onClick={() => voiceStore.deleteVoice(props.voice.id)}
						title="Delete download"
					>
						&times;
					</button>
				</Show>
			</div>
		</div>
	);
};

/** Whether the TTS graph is resident, with one-click load/unload. */
const EngineRow: Component = () => {
	const label = () => {
		if (voiceStore.state.loadingEngine) return "Loading…";
		return voiceStore.state.engineState === "ready" ? "Loaded in memory" : "Not loaded";
	};

	return (
		<div class={d.modelRow}>
			<div class={d.modelInfo}>
				<span class={d.modelName}>{label()}</span>
				<Show when={voiceStore.state.loadedModel}>
					<span class={d.modelSize}>{voiceStore.state.loadedModel}</span>
				</Show>
			</div>
			<div class={d.modelActions}>
				<Show
					when={voiceStore.state.engineState === "ready"}
					fallback={
						<button
							data-setting-exclusion="fastaf.voice_agent"
							class={d.modelDownload}
							disabled={voiceStore.state.loadingEngine}
							onClick={() => void voiceStore.loadEngine()}
						>
							Load
						</button>
					}
				>
					<button
						data-setting-exclusion="fastaf.voice_agent"
						class={d.modelSelect}
						disabled={voiceStore.state.sessionActive}
						title={voiceStore.state.sessionActive ? "Stop the voice session first" : "Free the memory"}
						onClick={() => void voiceStore.unloadEngine()}
					>
						Unload
					</button>
				</Show>
			</div>
		</div>
	);
};

export const VoiceTab: Component = () => {
	onMount(() => {
		void voiceStore.refreshConfig();
		void voiceStore.refreshModels();
		void voiceStore.refreshStatus();
		void voiceStore.refreshOutputDevices();
	});

	const selectedModelReady = () =>
		voiceStore.state.models.some((m) => m.name === voiceStore.state.config.model && m.downloaded);
	const selectedVoiceReady = () =>
		voiceStore.state.voices.some((v) => v.id === voiceStore.state.config.voice && v.downloaded);

	return (
		<div class={s.section}>
			<SettingPageHeader
				title="Voice"
				breadcrumb="AI / Voice"
				scope="This machine"
				description="Talk to AI Chat hands-free, entirely on this machine."
			/>

			<Show when={voiceStore.state.error}>
				<p class={s.warning}>{voiceStore.state.error}</p>
			</Show>

			<SectionCard
				title="Speech model"
				description="Kokoro speaks the replies; what you say is recognized with the Dictation model. The quantized model is a quarter the size and, at conversation speed, hard to tell apart."
			>
				<div class={d.modelList}>
					<For each={voiceStore.state.models}>{(model) => <ModelRow model={model} />}</For>
				</div>
			</SectionCard>

			<SectionCard
				title="Memory"
				description="Loading ahead of time means the first reply is spoken immediately; unloading frees the memory. A voice session loads it automatically."
			>
				<div class={d.modelList}>
					<EngineRow />
				</div>
			</SectionCard>

			<SectionCard title="Voices">
				<div class={d.modelList}>
					<For each={voiceStore.state.voices}>{(voice) => <VoiceRow voice={voice} />}</For>
				</div>
			</SectionCard>

			<SectionCard title="Playback">
				<SettingSlider
					data-setting-exclusion="fastaf.voice_agent"
					row
					label="Speaking rate"
					min={50}
					max={200}
					step={5}
					value={Math.round(voiceStore.state.config.speed * 100)}
					onChange={(value) => voiceStore.saveConfig({ speed: value / 100 })}
					formatValue={(value) => `${(value / 100).toFixed(2)}x`}
				/>
				<SettingSelect
					data-setting-exclusion="fastaf.voice_agent"
					row
					label="Output device"
					value={voiceStore.state.config.output_device ?? ""}
					onChange={(value) => voiceStore.saveConfig({ output_device: value || null })}
					options={[
						{ value: "", label: "System default" },
						...voiceStore.state.outputDevices.map((device) => ({
							value: device.name,
							label: device.is_default ? `${device.name} (default)` : device.name,
						})),
					]}
				/>
				<SettingToggle
					data-setting-exclusion="fastaf.voice_agent"
					row
					label="Interrupt by speaking (barge-in)"
					checked={voiceStore.state.config.barge_in}
					onChange={(checked) => voiceStore.saveConfig({ barge_in: checked })}
					hint={
						"Keeps listening while the agent talks, so you can cut it off mid-sentence. " +
						"Your own output is cancelled out of the microphone first, so this works on " +
						"speakers as well as headphones. Turn it off to mute the microphone until the " +
						"agent has finished instead."
					}
				/>
				<SettingToggle
					data-setting-exclusion="fastaf.voice_agent"
					row
					label="Speak up when an agent needs you"
					checked={voiceStore.state.config.speak_up}
					onChange={(checked) => voiceStore.saveConfig({ speak_up: checked })}
					hint={
						"FastAF says so out loud when an agent in another terminal stops on a question " +
						"or finishes, without being asked. It follows the notification sounds: a " +
						"terminal you have silenced stays silent, and nothing is said about the " +
						"terminal you are looking at."
					}
				/>
			</SectionCard>

			<Show when={!selectedModelReady() || !selectedVoiceReady()}>
				<p class={s.warning}>
					{!selectedModelReady()
						? "Download the speech model above before starting a voice session."
						: "Download the selected voice above before starting a voice session."}
				</p>
			</Show>
		</div>
	);
};
