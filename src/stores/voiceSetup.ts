import { createStore } from "solid-js/store";
import { t } from "../i18n";
import { appLogger } from "./appLogger";
import { dictationStore } from "./dictation";
import { providerRegistryStore } from "./providerRegistry";
import { settingsStore } from "./settings";
import { voiceIsReady, voiceStore } from "./voice";

/**
 * The speech-to-text model one-click setup downloads when none is on disk: the
 * quantized turbo. A third of the size of the configured default for the same
 * accuracy in practice, which is the difference between a wait and a coffee.
 */
export const SETUP_SPEECH_MODEL = "large-v3-turbo-q5";

export type VoiceSetupStep = "idle" | "speech" | "voice" | "done" | "failed";

interface VoiceSetupState {
	/**
	 * Voice was just turned on from the first-launch screen: the empty well's
	 * composer should start listening for what to build, once.
	 */
	firstPrompt: boolean;
	/** The dock is asking whether to download; nothing has started. */
	offered: boolean;
	running: boolean;
	step: VoiceSetupStep;
	error: string | null;
}

/** What still stands between this install and a spoken conversation. */
export interface VoiceSetupNeeds {
	/** Dictation is switched off. */
	dictation: boolean;
	/** No speech-to-text model is on disk (and no cloud provider is selected). */
	speech: boolean;
	/** The voice FastAF answers with is not on disk. */
	voice: boolean;
	/** AI Chat, the agent the conversation is with, is switched off. */
	chat: boolean;
	/** AI Chat has no model to think with. Setup cannot fix this one by itself. */
	brain: boolean;
}

function createVoiceSetup() {
	const [state, setState] = createStore<VoiceSetupState>({
		firstPrompt: false,
		offered: false,
		running: false,
		step: "idle",
		error: null,
	});

	/** The speech model setup will use: the configured one if it is on disk, else the small one. */
	const speechModel = (): string => {
		const selected = dictationStore.state.selectedModel;
		return dictationStore.state.models.some((m) => m.name === selected && m.downloaded) ? selected : SETUP_SPEECH_MODEL;
	};

	const speechReady = (): boolean =>
		dictationStore.state.sttProvider !== "local" ||
		dictationStore.state.models.some((m) => m.name === dictationStore.state.selectedModel && m.downloaded);

	const needs = (): VoiceSetupNeeds => ({
		dictation: !dictationStore.state.enabled,
		speech: !speechReady(),
		voice: !voiceIsReady(),
		chat: !settingsStore.isAiChatEnabled(),
		brain: providerRegistryStore.state.loaded && !providerRegistryStore.state.registry.slots.main,
	});

	/**
	 * A conversation can start. Dictation being switched off does not stand in
	 * the way — talk mode only shares its speech model — so an install that
	 * keeps dictation off is not asked to set anything up. (Setup still switches
	 * it on when it runs: the first-launch screen is turning voice on, all of
	 * it.) A missing model for AI Chat is not setup's to fix either.
	 */
	const ready = (): boolean => {
		const n = needs();
		return !n.speech && !n.voice && !n.chat;
	};

	/** Megabytes still to download, for the sentence that asks. */
	const downloadMb = (): number => {
		const n = needs();
		let mb = 0;
		if (n.speech) mb += dictationStore.state.models.find((m) => m.name === speechModel())?.size_hint_mb ?? 574;
		if (n.voice) {
			const model = voiceStore.state.models.find((m) => m.name === voiceStore.state.config.model);
			if (!model?.downloaded) mb += model?.size_hint_mb ?? 86;
		}
		return mb;
	};

	/** 0..100 across both downloads, weighted by their size. */
	const percent = (): number => {
		if (state.step === "done") return 100;
		const speechMb = dictationStore.state.models.find((m) => m.name === speechModel())?.size_hint_mb ?? 574;
		const voiceMb = voiceStore.state.models.find((m) => m.name === voiceStore.state.config.model)?.size_hint_mb ?? 86;
		const total = speechMb + voiceMb;
		if (state.step === "speech") return Math.round((speechMb * dictationStore.state.downloadPercent) / total);
		if (state.step === "voice")
			return Math.round((speechMb * 100 + voiceMb * voiceStore.state.downloadPercent) / total);
		return 0;
	};

	/** Read what is on disk and what is switched on. Cheap; call before asking `ready()`. */
	const refresh = async (): Promise<void> => {
		await Promise.all([
			dictationStore.refreshConfig(),
			dictationStore.refreshModels(),
			voiceStore.refreshConfig(),
			voiceStore.refreshModels(),
			providerRegistryStore.state.loaded ? Promise.resolve() : providerRegistryStore.hydrate().catch(() => {}),
		]);
	};

	const fail = (message: string) => {
		appLogger.warn("voice", "Voice setup failed", message);
		setState({ running: false, step: "failed", error: message });
	};

	/**
	 * Turn voice on: switch dictation and AI Chat on, and download the speech
	 * model and the voice if they are missing. One click, started by the user —
	 * nothing here runs on its own. Resolves true when a conversation can start.
	 */
	const run = async (): Promise<boolean> => {
		if (state.running) return false;
		setState({ offered: false, running: true, step: "speech", error: null });
		try {
			await refresh();
			const model = speechModel();
			const wanted = needs();

			if (wanted.dictation || (wanted.speech && dictationStore.state.selectedModel !== model)) {
				await dictationStore.saveConfig({ enabled: true, model });
			}
			if (wanted.chat) {
				settingsStore.setExperimentalFeaturesEnabled(true);
				settingsStore.setAiChatEnabled(true);
			}

			if (wanted.speech) {
				await dictationStore.downloadModel(model);
				if (!speechReady()) {
					fail(
						t(
							"voiceSetup.speechFailed",
							"The speech model could not be downloaded. Check the connection and try again.",
						),
					);
					return false;
				}
			}

			setState("step", "voice");
			if (!voiceIsReady()) {
				const { model: graph, voice } = voiceStore.state.config;
				if (!voiceStore.state.models.some((m) => m.name === graph && m.downloaded)) {
					await voiceStore.downloadModel(graph);
				}
				if (!voiceStore.state.voices.some((v) => v.id === voice && v.downloaded)) {
					await voiceStore.downloadVoice(voice);
				}
				if (!voiceIsReady()) {
					fail(
						voiceStore.state.error ||
							t("voiceSetup.voiceFailed", "The voice could not be downloaded. Check the connection and try again."),
					);
					return false;
				}
			}

			setState({ running: false, step: "done", error: null });
			return true;
		} catch (err) {
			fail(String(err));
			return false;
		}
	};

	return {
		state,
		needs,
		ready,
		downloadMb,
		percent,
		refresh,
		run,
		/** The first-launch screen finished: have the composer listen for the first task. */
		requestFirstPrompt(): void {
			setState("firstPrompt", true);
		},
		/** The composer took the request (or there was nothing to take it). */
		takeFirstPrompt(): boolean {
			const wanted = state.firstPrompt;
			if (wanted) setState("firstPrompt", false);
			return wanted;
		},
		/** Ask before downloading: the dock shows the size and two buttons. */
		offer(): void {
			setState({ offered: true, step: "idle", error: null });
		},
		/** "Not now", or the question went away. */
		dismiss(): void {
			setState({ offered: false, step: "idle", error: null });
		},
	};
}

export const voiceSetup = createVoiceSetup();
