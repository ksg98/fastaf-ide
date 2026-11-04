import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { mockInvoke } from "../mocks/tauri";

const mockStore = vi.hoisted(() => ({
	state: {
		enabled: false,
		hotkey: "F5",
		language: "auto",
		selectedModel: "large-v3-turbo",
		selectedDevice: null as string | null,
		models: [
			{ name: "small", display_name: "Small", size_hint_mb: 488, downloaded: false, actual_size_mb: 0 },
			{
				name: "large-v3-turbo",
				display_name: "Large V3 Turbo",
				size_hint_mb: 1620,
				downloaded: true,
				actual_size_mb: 1620,
			},
		],
		modelStatus: "downloaded",
		modelName: "large-v3-turbo",
		modelSizeMb: 1620,
		recording: false,
		processing: false,
		downloading: false,
		downloadPercent: 0,
		corrections: {},
		devices: [] as { name: string; is_default: boolean }[],
		rewriteEnabled: false,
		rewriteProviderId: "",
		rewriteModel: "",
		rewriteExtraBody: "",
		rewriteEffort: null as string | null,
		rewriteSystemPrompt: "",
		rewriteModels: [] as {
			id: string;
			supports_reasoning: boolean;
			effort_options: string[] | null;
			default_effort: string | null;
		}[],
		fetchingRewriteModels: false,
		rewriteModelsError: null as string | null,
		rewriting: false,
		sttProvider: "local",
		sttModelGroq: "",
		sttModelOpenai: "",
		sttModels: [] as string[],
		fetchingSttModels: false,
		sttModelsError: null as string | null,
		sttKeyExists: {} as Record<string, boolean>,
		longPressMs: 400,
		autoSend: true,
		rmsThreshold: 0.001,
		noSpeechThreshold: 0.6,
		audioLevel: 0,
		partialText: "",
		lastSkipReason: null as string | null,
		// The spoken-reply and hands-free half of the store. The panel reads
		// these unconditionally — `languageAsset()` calls `.find` on
		// `speechAssets` while deciding what to render — so leaving them out
		// does not merely skip those sections, it throws before the model list
		// this file is about is ever drawn.
		notifyModelOnHandsFree: true,
		handsFreeHoldBackMs: 1500,
		handsFreeEarcons: true,
		handsFreeStartNotice: "",
		handsFreeActivationPhrase: "",
		speechEngine: "pocket" as string,
		speechCommand: [] as string[],
		speechVoice: "",
		speechVolumeDb: -18,
		speechLevelling: 0.67,
		speechAssets: [] as unknown[],
		speechVoices: [] as { id: string; source: string }[],
		speechDownloads: {} as Record<string, number | undefined>,
		handsFree: null as unknown,
		handsFreeError: null as string | null,
		speech: null as unknown,
	},
	refreshConfig: vi.fn(),
	refreshStatus: vi.fn(),
	refreshCorrections: vi.fn(),
	refreshModels: vi.fn(),
	setRewriteEnabled: vi.fn(),
	setRewriteProviderId: vi.fn(),
	setRewriteModel: vi.fn(),
	setRewriteExtraBody: vi.fn(),
	setRewriteEffort: vi.fn(),
	setRewriteSystemPrompt: vi.fn(),
	fetchRewriteModels: vi.fn(),
	rewriteText: vi.fn(),
	setSttProvider: vi.fn(),
	setSttModel: vi.fn(),
	fetchSttModels: vi.fn(),
	refreshSttKeyExists: vi.fn(),
	saveSttApiKey: vi.fn(),
	deleteSttApiKey: vi.fn(),
	setEnabled: vi.fn(),
	setHotkey: vi.fn(),
	setLanguage: vi.fn(),
	setDevice: vi.fn(),
	setModel: vi.fn(),
	deleteModel: vi.fn(),
	downloadModel: vi.fn(),
	saveConfig: vi.fn(),
	saveCorrections: vi.fn(),
	refreshDevices: vi.fn(),
	startRecording: vi.fn(),
	stopRecording: vi.fn(),
	injectText: vi.fn(),
	setCapturingHotkey: vi.fn(),
	setLongPressMs: vi.fn(),
	setAutoSend: vi.fn(),
	setRmsThreshold: vi.fn(),
	setNoSpeechThreshold: vi.fn(),
	refreshSpeechAssets: vi.fn(),
	refreshSpeechStatus: vi.fn(),
	downloadSpeechAsset: vi.fn(),
	cancelSpeechDownload: vi.fn(),
	deleteSpeechAsset: vi.fn(),
	setSpeechVoice: vi.fn(),
	setSpeechEngine: vi.fn(),
	setSpeechCommand: vi.fn(),
	setSpeechVolumeDb: vi.fn(),
	setSpeechLevelling: vi.fn(),
	refreshSpeechVoices: vi.fn(),
	importSpeechVoice: vi.fn(() => Promise.resolve(null as string | null)),
	deleteSpeechVoice: vi.fn(),
	previewSpeechVoice: vi.fn(() => Promise.resolve(null as string | null)),
	refreshHandsFree: vi.fn(),
	armHandsFree: vi.fn(),
	disarmHandsFree: vi.fn(),
	setHandsFreeHoldBackMs: vi.fn(),
	setHandsFreeEarcons: vi.fn(),
	setHandsFreeActivationPhrase: vi.fn(),
	setNotifyModelOnHandsFree: vi.fn(),
	setHandsFreeStartNotice: vi.fn(),
	resetHandsFreeStartNotice: vi.fn(),
	getDefaultHandsFreeStartNotice: vi.fn(() => Promise.resolve("")),
}));

vi.mock("../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsExpertMode: (enabled: boolean) => setState("settingsExpertMode", enabled),
		},
	};
});

// Which client the panel believes it runs in. FastAF's voice agent (Settings ›
// Voice) is the desktop's hands-free mode, so upstream's hands-free card and its
// speech engine render in a browser only. Browser-mode invoke goes through
// transport rpc, routed to the same mock as the desktop's Tauri invoke.
const client = vi.hoisted(() => ({ tauri: true }));
vi.mock("../../transport", async (importOriginal) => {
	const { mockInvoke } = await import("../mocks/tauri");
	return {
		...(await importOriginal<typeof import("../../transport")>()),
		isTauri: () => client.tauri,
		rpc: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args),
	};
});
/** Render as a browser client, where hands-free and spoken replies live. */
const inBrowser = () => {
	client.tauri = false;
};

vi.mock("../../stores/dictation", () => ({
	dictationStore: mockStore,
	WHISPER_LANGUAGES: { auto: "Auto-detect", en: "English", it: "Italian", ja: "Japanese" },
}));

const mockRegistry = vi.hoisted(() => ({
	state: {
		registry: {
			schema_version: 3,
			providers: [] as { id: string; type: string; label: string }[],
			models: [] as { id: string; provider_id: string; model_name: string; tier: string }[],
			slots: {} as Record<string, string>,
			features: {},
		},
	},
	hydrate: vi.fn(),
}));

vi.mock("../../stores/providerRegistry", () => ({ providerRegistryStore: mockRegistry }));

import { DictationSettings } from "../../components/SettingsPanel/DictationSettings";
import { settingsExpertStore } from "../../stores/settingsExpert";
import { uiStore } from "../../stores/ui";

// Pocket TTS is the default engine (Microsoft Edge's online voices are retired).
// Desktop is the default client; the hands-free and spoken-reply blocks opt in to a browser.
beforeEach(() => {
	mockStore.state.speechEngine = "pocket";
	client.tauri = true;
});

describe("DictationSettings – consistent voice presentation", () => {
	// Browser-only in FastAF: the desktop speaks through the Voice page.
	beforeEach(inBrowser);

	afterEach(() => {
		mockStore.state.language = "auto";
		mockStore.state.speechAssets = [];
	});
	it("keeps model and reply voice choices accessible", () => {
		mockStore.state.language = "en";
		mockStore.state.speechAssets = [
			{
				id: "english",
				kind: "language",
				display_name: "English",
				language: "en",
				voices: ["alba"],
				download_bytes: 1,
				state: "ready",
			},
		];
		const view = render(() => <DictationSettings />);
		// FastAF picks the Whisper model on its own row ("Use"), not from a dropdown.
		const whisper = view.container.querySelector('[data-whisper-model="large-v3-turbo"]') as HTMLElement;
		expect(within(whisper).getByRole("button", { name: "Delete model" })).toBeTruthy();
		expect(view.getByRole("combobox", { name: "Voice" }).tagName).toBe("SELECT");
	});

	it("keeps downloaded Pocket and Whisper assets labelled with working removal actions", () => {
		vi.clearAllMocks();
		mockStore.state.speechEngine = "pocket";
		mockStore.state.speechAssets = [
			{
				id: "runtime",
				kind: "runtime",
				display_name: "Runtime",
				language: null,
				voices: [],
				download_bytes: 1_000_000,
				state: "ready",
			},
		];
		const view = render(() => <DictationSettings />);
		const whisper = view.container.querySelector('[data-whisper-model="large-v3-turbo"]')!;
		const speech = view.container.querySelector("[data-speech-downloads]")!;
		expect(whisper.textContent).toContain("Downloaded");
		expect(speech.textContent).toContain("Downloaded");
		// A Whisper model is up to 1.6 GB, so its removal asks first.
		fireEvent.click(within(whisper as HTMLElement).getByRole("button", { name: "Delete model" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(within(speech as HTMLElement).getByRole("button", { name: "Remove" }));
		expect(mockStore.deleteModel).toHaveBeenCalledWith("large-v3-turbo");
		expect(mockStore.deleteSpeechAsset).toHaveBeenCalledWith("runtime");
	});

	it("prevents the external speech command from bypassing shared row labels and help", () => {
		mockStore.state.speechEngine = "external";
		const { container } = render(() => <DictationSettings />);
		const command = container.querySelector<HTMLTextAreaElement>('[data-setting-id="voice.speech_command"]')!;
		expect(command.id).toBeTruthy();
		expect(container.querySelector(`label[for="${command.id}"]`)?.textContent).toBe("Speech command");
		const description = document.getElementById(command.getAttribute("aria-describedby")!);
		expect(description?.textContent).toContain("One argument per line, no shell.");
	});
});

describe("DictationSettings – Model Selector", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: check_microphone_permission returns "not_determined" (no auto-detect)
		mockInvoke.mockResolvedValue("not_determined");
		// Reset models to default test data
		mockStore.state.models = [
			{ name: "small", display_name: "Small", size_hint_mb: 488, downloaded: false, actual_size_mb: 0 },
			{
				name: "large-v3-turbo",
				display_name: "Large V3 Turbo",
				size_hint_mb: 1620,
				downloaded: true,
				actual_size_mb: 1620,
			},
		];
		mockStore.state.selectedModel = "large-v3-turbo";
		mockStore.state.selectedDevice = null;
		mockStore.state.downloading = false;
		mockStore.state.downloadPercent = 0;
		mockStore.state.devices = [];
	});

	it("calls refreshModels on mount", () => {
		render(() => <DictationSettings />);
		expect(mockStore.refreshModels).toHaveBeenCalledOnce();
	});

	it("renders a row for each model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		expect(rows.length).toBe(2);
	});

	it("shows display name and size hint for each model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");

		expect(rows[0].textContent).toContain("Small");
		expect(rows[0].textContent).toContain("488");
		expect(rows[1].textContent).toContain("Large V3 Turbo");
		expect(rows[1].textContent).toContain("1620");
	});

	it("shows download button for not-downloaded models", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		const downloadBtn = rows[0].querySelector(".modelDownload");
		expect(downloadBtn).not.toBeNull();
		expect(downloadBtn!.textContent).toContain("Download");
	});

	it("shows delete button for downloaded models", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		const deleteBtn = rows[1].querySelector(".modelDelete");
		expect(deleteBtn).not.toBeNull();
	});

	it("marks the selected model as active", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		expect(rows[1].classList.contains("active")).toBe(true);
		expect(rows[0].classList.contains("active")).toBe(false);
	});

	it("clicking a downloaded model calls setModel", () => {
		// Both models downloaded for this test
		mockStore.state.models = [
			{ name: "small", display_name: "Small", size_hint_mb: 488, downloaded: true, actual_size_mb: 488 },
			{
				name: "large-v3-turbo",
				display_name: "Large V3 Turbo",
				size_hint_mb: 1620,
				downloaded: true,
				actual_size_mb: 1620,
			},
		];

		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		const selectBtn = rows[0].querySelector(".modelSelect");
		expect(selectBtn).not.toBeNull();
		fireEvent.click(selectBtn!);
		expect(mockStore.setModel).toHaveBeenCalledWith("small");
	});

	it("download button calls downloadModel with model name", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		const downloadBtn = rows[0].querySelector(".modelDownload");
		fireEvent.click(downloadBtn!);
		expect(mockStore.downloadModel).toHaveBeenCalledWith("small");
	});

	it("delete button asks first, then calls deleteModel with model name", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		const deleteBtn = rows[1].querySelector(".modelDelete");
		fireEvent.click(deleteBtn!);
		// A 1.6 GB download must not vanish on one click.
		expect(mockStore.deleteModel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(mockStore.deleteModel).toHaveBeenCalledWith("large-v3-turbo");
	});

	it("cancelling the delete keeps the model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		fireEvent.click(rows[1].querySelector(".modelDelete")!);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(mockStore.deleteModel).not.toHaveBeenCalled();
	});

	it("does not allow selecting a not-downloaded model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");
		// Not-downloaded model should not have a select button
		const selectBtn = rows[0].querySelector(".modelSelect");
		expect(selectBtn).toBeNull();
	});

	it("shows status badge for each model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = container.querySelectorAll(".modelRow");

		const badge0 = rows[0].querySelector(".modelBadge");
		expect(badge0).not.toBeNull();

		const badge1 = rows[1].querySelector(".modelBadge");
		expect(badge1).not.toBeNull();
		expect(badge1!.textContent).toContain("Downloaded");
	});

	it("shows progress bar when downloading", () => {
		mockStore.state.downloading = true;
		mockStore.state.downloadPercent = 42;
		// Mark which model is being downloaded by setting selectedModel to the downloading one
		mockStore.state.selectedModel = "small";

		const { container } = render(() => <DictationSettings />);
		const progressBar = container.querySelector(".progressFill");
		expect(progressBar).not.toBeNull();
	});
});

describe("DictationSettings – STT Provider", () => {
	/** Find the provider <select> by looking for one whose first option value is "local" */
	function findProviderSelect(container: HTMLElement): HTMLSelectElement | null {
		const selects = container.querySelectorAll("select");
		for (const s of selects) {
			if (s.querySelector("option")?.value === "local") return s;
		}
		return null;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.sttProvider = "local";
		mockStore.state.sttModelGroq = "";
		mockStore.state.sttModelOpenai = "";
		mockStore.state.sttModels = [];
		mockStore.state.sttModelsError = null;
		mockStore.state.sttKeyExists = {};
	});

	it("renders provider select with local/groq/openai options", () => {
		const { container } = render(() => <DictationSettings />);
		const select = findProviderSelect(container);
		expect(select).not.toBeNull();
		const values = Array.from(select!.querySelectorAll("option")).map((o) => o.value);
		expect(values).toEqual(["local", "groq", "openai"]);
	});

	it("shows the whisper model list for the local provider and no API key row", () => {
		const { container } = render(() => <DictationSettings />);
		expect(container.querySelectorAll(".modelRow").length).toBe(2);
		const buttons = Array.from(container.querySelectorAll("button"));
		expect(buttons.find((b) => b.textContent?.includes("Fetch models"))).toBeUndefined();
	});

	it("switching provider calls setSttProvider and refreshSttKeyExists", () => {
		const { container } = render(() => <DictationSettings />);
		const select = findProviderSelect(container)!;
		fireEvent.change(select, { target: { value: "groq" } });
		expect(mockStore.setSttProvider).toHaveBeenCalledWith("groq");
		expect(mockStore.refreshSttKeyExists).toHaveBeenCalledWith("groq");
	});

	it("cloud provider hides the whisper model list and shows key input + fetch button", () => {
		mockStore.state.sttProvider = "groq";
		const { container } = render(() => <DictationSettings />);
		expect(container.querySelectorAll(".modelRow").length).toBe(0);
		const buttons = Array.from(container.querySelectorAll("button"));
		const fetchBtn = buttons.find((b) => b.textContent?.includes("Fetch models"));
		expect(fetchBtn).not.toBeUndefined();
		fireEvent.click(fetchBtn!);
		expect(mockStore.fetchSttModels).toHaveBeenCalledWith("groq");
	});

	it("appends the saved model when absent from fetched list", () => {
		mockStore.state.sttProvider = "openai";
		mockStore.state.sttModelOpenai = "whisper-1";
		mockStore.state.sttModels = ["gpt-4o-transcribe"];
		const { container } = render(() => <DictationSettings />);
		const selects = Array.from(container.querySelectorAll("select"));
		const modelSelect = selects.find((s) =>
			Array.from(s.querySelectorAll("option")).some((o) => o.value === "gpt-4o-transcribe"),
		);
		expect(modelSelect).not.toBeUndefined();
		const values = Array.from(modelSelect!.querySelectorAll("option")).map((o) => o.value);
		expect(values).toContain("whisper-1");
		fireEvent.change(modelSelect!, { target: { value: "gpt-4o-transcribe" } });
		expect(mockStore.setSttModel).toHaveBeenCalledWith("openai", "gpt-4o-transcribe");
	});

	it("refreshes key existence for both providers on mount", () => {
		render(() => <DictationSettings />);
		expect(mockStore.refreshSttKeyExists).toHaveBeenCalledWith("groq");
		expect(mockStore.refreshSttKeyExists).toHaveBeenCalledWith("openai");
	});
});

describe("DictationSettings – Microphone Selector", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.devices = [];
		mockStore.state.selectedDevice = null;
	});

	it("shows Detect Microphones button when no devices loaded", () => {
		const { container } = render(() => <DictationSettings />);
		const buttons = Array.from(container.querySelectorAll("button"));
		const detectBtn = buttons.find((b) => b.textContent?.includes("Detect"));
		expect(detectBtn).not.toBeNull();
	});

	/** Find the device <select> by looking for one whose first option says "System Default" */
	function findDeviceSelect(container: HTMLElement): HTMLSelectElement | null {
		const selects = container.querySelectorAll("select");
		for (const s of selects) {
			if (s.querySelector("option")?.textContent?.includes("System Default")) return s;
		}
		return null;
	}

	it("shows device dropdown with System Default when devices are loaded", () => {
		mockStore.state.devices = [
			{ name: "Built-in Microphone", is_default: true },
			{ name: "USB Mic", is_default: false },
		];

		const { container } = render(() => <DictationSettings />);
		const select = findDeviceSelect(container);
		expect(select).not.toBeNull();
		const options = select!.querySelectorAll("option");
		// System Default + 2 devices = 3 options
		expect(options.length).toBe(3);
		expect(options[0].textContent).toContain("System Default");
		expect(options[0].value).toBe("");
		expect(options[1].textContent).toContain("Built-in Microphone");
		expect(options[2].textContent).toContain("USB Mic");
	});

	it("calls setDevice when selecting a specific device", () => {
		mockStore.state.devices = [
			{ name: "Built-in Microphone", is_default: true },
			{ name: "USB Mic", is_default: false },
		];

		const { container } = render(() => <DictationSettings />);
		const select = findDeviceSelect(container)!;
		fireEvent.change(select, { target: { value: "USB Mic" } });
		expect(mockStore.setDevice).toHaveBeenCalledWith("USB Mic");
	});

	it("calls setDevice(null) when selecting System Default", () => {
		mockStore.state.devices = [{ name: "Built-in Microphone", is_default: true }];
		mockStore.state.selectedDevice = "Built-in Microphone";

		const { container } = render(() => <DictationSettings />);
		const select = findDeviceSelect(container)!;
		fireEvent.change(select, { target: { value: "" } });
		expect(mockStore.setDevice).toHaveBeenCalledWith(null);
	});

	it("auto-detects devices on mount when mic is authorized", async () => {
		mockInvoke.mockResolvedValue("authorized");

		render(() => <DictationSettings />);
		// Wait for the async onMount to complete
		await new Promise((r) => setTimeout(r, 0));

		expect(mockInvoke).toHaveBeenCalledWith("check_microphone_permission");
		expect(mockStore.refreshDevices).toHaveBeenCalled();
	});

	it("does not auto-detect devices when mic is not determined", async () => {
		mockInvoke.mockResolvedValue("not_determined");

		render(() => <DictationSettings />);
		await new Promise((r) => setTimeout(r, 0));

		expect(mockInvoke).toHaveBeenCalledWith("check_microphone_permission");
		expect(mockStore.refreshDevices).not.toHaveBeenCalled();
	});

	it("logs warning when mic is denied", async () => {
		mockInvoke.mockResolvedValue("denied");
		const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		render(() => <DictationSettings />);
		await new Promise((r) => setTimeout(r, 0));

		const warnCalls = consoleSpy.mock.calls;
		const micWarning = warnCalls.find(
			(call) => typeof call[1] === "string" && call[1].includes("Microphone access denied"),
		);
		expect(micWarning).toBeDefined();
		expect(mockStore.refreshDevices).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

describe("DictationSettings – AI Rewrite", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.rewriteEnabled = true;
		mockStore.state.rewriteProviderId = "local-openai";
		mockStore.state.rewriteModel = "";
		mockStore.state.rewriteExtraBody = "";
		mockStore.state.rewriteEffort = null;
		mockStore.state.rewriteModels = [];
		mockStore.state.rewriteModelsError = null;
		mockRegistry.state.registry.providers = [
			{ id: "local-openai", type: "custom", label: "Local (OpenAI-compatible)" },
		];
		mockRegistry.state.registry.models = [];
		mockRegistry.state.registry.slots = {};
	});

	// Catches: the card's first row repeating the card title ("AI Rewrite" / "AI Rewrite").
	it("opens the AI Rewrite card with a toggle row that names the action, not the card", () => {
		const { container } = render(() => <DictationSettings />);
		const card = Array.from(container.querySelectorAll("section")).find(
			(section) => section.querySelector("h3")?.textContent === "AI Rewrite",
		)!;
		const labels = Array.from(card.querySelectorAll("label")).map((label) => label.textContent);
		expect(labels[0]).toBe("Rewrite transcripts");
		expect(labels).not.toContain("AI Rewrite");
		const toggle = card.querySelector<HTMLInputElement>('input[data-setting-id="voice.rewrite_enabled"]')!;
		expect(toggle.checked).toBe(true);
		fireEvent.change(toggle, { target: { checked: false } });
		expect(mockStore.setRewriteEnabled).toHaveBeenCalledWith(false);
	});

	it("hydrates the provider registry on mount", () => {
		render(() => <DictationSettings />);
		expect(mockRegistry.hydrate).toHaveBeenCalled();
	});

	it("lists the registry's providers to pick from", () => {
		const { container } = render(() => <DictationSettings />);
		const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
		expect(options).toContain("Local (OpenAI-compatible)");
	});

	it("fetches models from the endpoint on demand", () => {
		const { getByText } = render(() => <DictationSettings />);
		fireEvent.click(getByText("Fetch models"));
		expect(mockStore.fetchRewriteModels).toHaveBeenCalled();
	});

	it("offers the fetched models and saves the pick", () => {
		mockStore.state.rewriteModels = [
			{ id: "gpt-5.6-terra", supports_reasoning: true, effort_options: null, default_effort: null },
			{ id: "qwen2.5-coder", supports_reasoning: false, effort_options: null, default_effort: null },
		];
		const { container } = render(() => <DictationSettings />);
		const select = Array.from(container.querySelectorAll("select")).find((s) =>
			Array.from(s.options).some((o) => o.value === "gpt-5.6-terra"),
		);
		expect(select).toBeTruthy();
		expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toContain("qwen2.5-coder");
		fireEvent.change(select as HTMLSelectElement, { target: { value: "gpt-5.6-terra" } });
		expect(mockStore.setRewriteModel).toHaveBeenCalledWith("gpt-5.6-terra");
	});

	it("keeps a saved model that the endpoint did not return", () => {
		mockStore.state.rewriteModel = "retired-model";
		mockStore.state.rewriteModels = [
			{ id: "gpt-5.6-terra", supports_reasoning: false, effort_options: null, default_effort: null },
		];
		const { container } = render(() => <DictationSettings />);
		const values = Array.from(container.querySelectorAll("option")).map((o) => o.value);
		expect(values).toContain("retired-model");
	});

	it("uses the effort levels the endpoint advertised for the model", () => {
		mockStore.state.rewriteModel = "reasoner";
		mockStore.state.rewriteModels = [
			{
				id: "reasoner",
				supports_reasoning: true,
				effort_options: ["low", "high"],
				default_effort: "high",
			},
		];
		const { container } = render(() => <DictationSettings />);
		const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
		expect(options).toContain("low");
		expect(options).toContain("high (default)");
	});

	it("falls back to a free-text effort when the model advertises none", () => {
		mockStore.state.rewriteModel = "plain";
		mockStore.state.rewriteModels = [
			{ id: "plain", supports_reasoning: false, effort_options: null, default_effort: null },
		];
		const { container } = render(() => <DictationSettings />);
		const input = container.querySelector('input[placeholder="unset — model decides"]');
		expect(input).toBeTruthy();
		fireEvent.change(input as HTMLInputElement, { target: { value: "ultra" } });
		expect(mockStore.setRewriteEffort).toHaveBeenCalledWith("ultra");
	});

	it("shows the composed request body on demand", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "dictation_rewrite_request_preview"
				? Promise.resolve('{\n  "model": "gpt-5.6-terra"\n}')
				: Promise.resolve("not_determined"),
		);
		const { getByText, findByText } = render(() => <DictationSettings />);
		fireEvent.click(getByText("Show request body"));
		expect(await findByText(/"model": "gpt-5.6-terra"/)).toBeTruthy();
	});

	it("surfaces a fetch failure instead of silently offering nothing", () => {
		mockStore.state.rewriteModelsError = "Models request failed (404)";
		const { getByText } = render(() => <DictationSettings />);
		expect(getByText("Models request failed (404)")).toBeTruthy();
	});

	it("tells the user to configure a provider when the registry is empty", () => {
		mockRegistry.state.registry.providers = [];
		const { getByText } = render(() => <DictationSettings />);
		expect(getByText(/No AI providers configured yet/)).toBeTruthy();
	});
});

describe("DictationSettings – Voice Tuning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.rmsThreshold = 0.001;
		mockStore.state.noSpeechThreshold = 0.6;
		mockStore.state.audioLevel = 0;
		mockStore.state.partialText = "";
		mockStore.state.lastSkipReason = null;
		mockStore.state.recording = false;
		mockStore.state.processing = false;
	});

	/** The level gate slider and the marker both read in meter units. */
	const gateReadout = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("span")).find((el) => el.textContent?.startsWith("Gate:"));

	it("shows the level gate on the meter's own scale, not as a raw RMS", () => {
		// meter = sqrt(rms * 20): 0.001 lands at 14%, a number the user can
		// compare against the bar. "0.001" on a 0–100% meter cannot be.
		const { container } = render(() => <DictationSettings />);
		expect(gateReadout(container)?.textContent).toBe("Gate: 14%");
	});

	it("converts a slider move back to a raw RMS before saving", () => {
		const { container } = render(() => <DictationSettings />);
		const slider = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
			(el) => el.max === "50",
		);
		expect(slider).toBeDefined();

		fireEvent.input(slider as HTMLInputElement, { target: { value: "30" } });

		// 0.30^2 / 20 = 0.0045
		expect(mockStore.setRmsThreshold).toHaveBeenCalledWith(0.0045);
	});

	it("reports why the last recording was rejected", () => {
		mockStore.state.lastSkipReason = "no speech detected (no_speech 0.91 > 0.60)";
		const { container } = render(() => <DictationSettings />);
		expect(container.textContent).toContain("no speech detected (no_speech 0.91 > 0.60)");
	});

	it("starts a test recording from the panel", async () => {
		mockStore.startRecording.mockResolvedValue(undefined);

		const { getByText } = render(() => <DictationSettings />);
		fireEvent.click(getByText("Start test recording"));
		await Promise.resolve();

		expect(mockStore.startRecording).toHaveBeenCalledOnce();
	});

	it("keeps the test transcript in the panel instead of sending it anywhere", async () => {
		// The point of the harness: tuning must not fire text at whatever
		// terminal happens to be focused behind the settings panel.
		mockStore.state.recording = true;
		mockStore.stopRecording.mockResolvedValue({
			text: "run the tests",
			skip_reason: null,
			duration_s: 1.2,
			truncated_s: 0,
		});

		const { container, getByText } = render(() => <DictationSettings />);
		fireEvent.click(getByText("Stop test"));
		await new Promise((r) => setTimeout(r, 0));

		expect(mockStore.stopRecording).toHaveBeenCalledOnce();
		expect(mockStore.injectText).not.toHaveBeenCalled();
		expect(container.textContent).toContain("run the tests");
	});
});

describe("DictationSettings – Spoken replies", () => {
	const asset = (id: string, language: string | null, state: string) => ({
		id,
		display_name: id,
		kind: language ? "language" : "runtime",
		language,
		voices: [],
		download_bytes: 1_000_000,
		state,
	});

	/** The speech rows, which follow the Whisper rows in the same markup. */
	const speechRows = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("[data-speech-downloads] .assetRow"));

	beforeEach(() => {
		// Browser-only in FastAF: the desktop speaks through the Voice page.
		inBrowser();
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.speechEngine = "pocket";
		mockStore.state.language = "it";
		mockStore.state.speechDownloads = {};
		mockStore.state.speechAssets = [
			asset("runtime", null, "ready"),
			asset("italian", "it", "ready"),
			asset("english", "en", "ready"),
		];
	});

	it("marks only the language replies are spoken in as active, like the selected Whisper model", () => {
		const { container } = render(() => <DictationSettings />);
		const rows = speechRows(container);
		const active = rows.filter((row) => row.textContent?.includes("Active")).map((row) => row.textContent);
		expect(active).toHaveLength(1);
		expect(active[0]).toContain("italian");
		expect(active[0]).toContain("Active");
		expect(rows.every((row) => row.textContent?.includes("Downloaded"))).toBe(true);
	});

	it("keeps catalogue voices out of the download list, and never lets one stand in for its language", () => {
		// `get_speech_assets` also returns every catalogue voice (`kind: "voice"`,
		// with its language's code). Voices belong in the voice list, not among
		// the runtime and language downloads.
		mockStore.state.speechAssets = [
			{ ...asset("voice-italian-jean", "it", "absent"), kind: "voice", voice: "jean" },
			...mockStore.state.speechAssets,
		];
		const { container } = render(() => <DictationSettings />);
		const rows = Array.from(container.querySelectorAll("[data-speech-downloads] .assetRow"));
		expect(rows).toHaveLength(3);
		expect(rows.some((row) => row.textContent?.includes("voice-italian-jean"))).toBe(false);
		const active = rows.filter((row) => row.textContent?.includes("Active"));
		expect(active.map((row) => row.textContent)).toEqual([expect.stringContaining("italian")]);
	});

	it("cancels a running download from the named shared action", () => {
		mockStore.state.speechDownloads = { english: 40 };
		const { container } = render(() => <DictationSettings />);
		const english = speechRows(container).find((row) => row.textContent?.includes("english"))!;
		const cancel = english.querySelector('button[title="Cancel"]') as HTMLButtonElement;
		expect(cancel.textContent).toBe("Cancel");
		fireEvent.click(cancel);
		expect(mockStore.cancelSpeechDownload).toHaveBeenCalledWith("english");
	});
});

describe("DictationSettings – Voice library", () => {
	const voiceAsset = (voice: string, language: string, state: string) => ({
		id: `voice-${language}-${voice}`,
		display_name: voice,
		kind: "voice",
		language,
		voice,
		voices: [],
		download_bytes: 6_000_000,
		state,
	});

	const group = (container: HTMLElement, name: string) =>
		container.querySelector(`[data-voice-group="${name}"]`) as HTMLElement | null;
	const button = (root: ParentNode, text: string) =>
		Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
	const slider = (container: HTMLElement, label: string) =>
		Array.from(container.querySelectorAll("label"))
			.find((el) => el.textContent === label)
			?.closest(".settingRow, .group")
			?.querySelector('input[type="range"]') as HTMLInputElement;
	const voiceSelect = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("select")).find((el) =>
			Array.from(el.options).some((o) => o.textContent === "Default for this language"),
		) as HTMLSelectElement;

	beforeEach(() => {
		// Browser-only in FastAF: the desktop speaks through the Voice page.
		inBrowser();
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.speechEngine = "pocket";
		mockStore.state.language = "it";
		mockStore.state.speechVoice = "";
		mockStore.state.speechVolumeDb = -18;
		mockStore.state.speechLevelling = 0.67;
		mockStore.state.speechDownloads = { "voice-it-marco": 30 };
		mockStore.state.speechAssets = [
			{
				id: "italian",
				display_name: "Italian",
				kind: "language",
				language: "it",
				voices: ["giovanni"],
				download_bytes: 1,
				state: "ready",
			},
			voiceAsset("jean", "it", "ready"),
			voiceAsset("alba", "it", "absent"),
			voiceAsset("marco", "it", "downloading"),
			voiceAsset("lola", "es", "absent"),
		];
		mockStore.state.speechVoices = [
			{ id: "giovanni", source: "default" },
			{ id: "jean", source: "downloaded" },
			{ id: "my_voice", source: "user" },
		];
	});

	it("reads the voices of the language replies are spoken in", () => {
		render(() => <DictationSettings />);
		expect(mockStore.refreshSpeechVoices).toHaveBeenCalledWith("it");
	});

	it("groups the language's voices into Installed, Downloadable and Yours", () => {
		const { container } = render(() => <DictationSettings />);
		expect(group(container, "installed")?.textContent).toContain("jean");
		const downloadable = group(container, "downloadable") as HTMLElement;
		expect(downloadable.textContent).toContain("alba");
		expect(downloadable.textContent).toContain("marco");
		expect(downloadable.textContent).toContain("30%");
		expect(group(container, "yours")?.textContent).toContain("my_voice");
		// Another language's voice is in none of them.
		expect(container.textContent).not.toContain("lola");
	});

	it("downloads a voice from its own row", () => {
		const { container } = render(() => <DictationSettings />);
		const row = Array.from(group(container, "downloadable")!.querySelectorAll(".assetRow")).find((r) =>
			r.textContent?.includes("alba"),
		)!;
		fireEvent.click(button(row, "Download")!);
		expect(mockStore.downloadSpeechAsset).toHaveBeenCalledWith("voice-it-alba");
	});

	it("imports a voice file into the language and deletes a user voice", async () => {
		const { container } = render(() => <DictationSettings />);
		const yours = group(container, "yours")!;
		expect(button(yours, "Add voice file…")).toBeDefined();
		const input = yours.querySelector('input[type="file"]') as HTMLInputElement;
		const file = new File([new Uint8Array([1])], "mine.safetensors");
		fireEvent.change(input, { target: { files: [file] } });
		await Promise.resolve();
		expect(mockStore.importSpeechVoice).toHaveBeenCalledWith("it", file);

		fireEvent.click(yours.querySelector('button[title="Delete this voice file"]') as HTMLButtonElement);
		expect(mockStore.deleteSpeechVoice).toHaveBeenCalledWith("it", "my_voice");
	});

	it("shows why an imported file was refused", async () => {
		mockStore.importSpeechVoice.mockResolvedValueOnce("the voice file is over the 64 MB limit");
		const { container, findByText } = render(() => <DictationSettings />);
		const input = group(container, "yours")!.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "big.safetensors")] } });
		expect(await findByText("the voice file is over the 64 MB limit")).toBeDefined();
	});

	it("keeps a missing configured catalogue voice selected instead of an empty picker", () => {
		// Catches: speech_voice not among installed-only options blanks the native select.
		mockStore.state.speechVoice = "bill_boerst";
		mockStore.state.speechAssets.push(voiceAsset("bill_boerst", "it", "absent"));
		mockStore.state.speechVoices = [{ id: "giovanni", source: "default" }];
		const { container } = render(() => <DictationSettings />);
		const select = voiceSelect(container);
		expect(select.value).toBe("bill_boerst");
		expect(select.selectedOptions[0].textContent).toContain("Not downloaded");
		const values = Array.from(select.options).map((o) => o.value);
		expect(values).toEqual(["", "giovanni", "jean", "alba", "marco", "bill_boerst"]);
		expect(values).not.toContain("lola");
		const row = select.closest('[class*="settingRow"]')!;
		fireEvent.click(button(row, "Download")!);
		expect(mockStore.downloadSpeechAsset).toHaveBeenCalledWith("voice-it-bill_boerst");
	});

	it("offers installed and downloadable voices in the voice picker", () => {
		const { container } = render(() => <DictationSettings />);
		const values = Array.from(voiceSelect(container).options).map((o) => o.value);
		expect(values).toEqual(["", "giovanni", "jean", "my_voice", "alba", "marco"]);
	});

	it("offers catalogue downloads but no shipped voice while the language is absent", () => {
		// No voice speaks without the language's model, so the shipped voice
		// the catalogue names must not stand in for an empty answer.
		mockStore.state.speechAssets[0] = {
			id: "italian",
			display_name: "Italian",
			kind: "language",
			language: "it",
			voices: ["giovanni"],
			download_bytes: 1,
			state: "absent",
		};
		mockStore.state.speechVoices = [];
		const { container } = render(() => <DictationSettings />);
		const values = Array.from(voiceSelect(container).options).map((o) => o.value);
		expect(values).toEqual(["", "jean", "alba", "marco"]);
	});

	it("keeps the Downloadable voices collapsed behind a disclosure that shows how many there are", () => {
		// A language offers two dozen voices; listed open they push the volume
		// sliders out of sight.
		const { container } = render(() => <DictationSettings />);
		const disclosure = group(container, "downloadable") as HTMLDetailsElement;
		expect(disclosure.tagName).toBe("DETAILS");
		expect(disclosure.open).toBe(false);
		// A native <summary> is focusable and toggles on Enter and Space.
		const summary = disclosure.querySelector(":scope > summary") as HTMLElement;
		expect(summary.textContent).toContain("Downloadable");
		expect(summary.textContent).toContain("2");
		fireEvent.click(summary);
		expect(disclosure.open).toBe(true);
	});

	it("Listen previews the selected voice and shows a refusal inline", async () => {
		mockStore.state.speechVoice = "jean";
		mockStore.previewSpeechVoice.mockResolvedValueOnce("a reply is being spoken; try again when it ends");
		const { container, findByText } = render(() => <DictationSettings />);
		fireEvent.click(button(container, "Listen")!);
		expect(mockStore.previewSpeechVoice).toHaveBeenCalledWith("it", "jean");
		expect(await findByText("a reply is being spoken; try again when it ends")).toBeDefined();
	});

	it("saves Voice volume and Levelling when the drag is released, not while it moves", () => {
		const { container } = render(() => <DictationSettings />);
		const volume = slider(container, "Voice volume");
		expect(volume.value).toBe("-18");
		fireEvent.input(volume, { target: { value: "-24" } });
		expect(mockStore.setSpeechVolumeDb).not.toHaveBeenCalled();
		expect(volume.parentElement?.textContent).toContain("-24 dB");
		fireEvent.change(volume, { target: { value: "-24" } });
		expect(mockStore.setSpeechVolumeDb).toHaveBeenCalledWith(-24);

		const levelling = slider(container, "Levelling");
		expect(levelling.value).toBe("67");
		fireEvent.input(levelling, { target: { value: "0" } });
		expect(levelling.parentElement?.textContent).toContain("Off");
		fireEvent.change(levelling, { target: { value: "0" } });
		expect(mockStore.setSpeechLevelling).toHaveBeenCalledWith(0);
	});
});

describe("DictationSettings – Language without spoken replies", () => {
	const languageAsset = (language: string) => ({
		id: language,
		display_name: language,
		kind: "language",
		language,
		voices: [],
		download_bytes: 1_000_000,
		state: "ready",
	});

	const languageSelect = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("select")).find((select) =>
			Array.from(select.options).some((option) => option.value === "ja"),
		)!;
	const optionText = (container: HTMLElement, code: string) =>
		Array.from(languageSelect(container).options).find((option) => option.value === code)?.textContent;
	const noVoiceHint = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("p")).find((p) => p.textContent?.includes("will not be spoken"));

	beforeEach(() => {
		// Browser-only in FastAF: the desktop speaks through the Voice page.
		inBrowser();
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.state.speechEngine = "pocket";
		mockStore.state.speechDownloads = {};
		mockStore.state.speechAssets = [languageAsset("it"), languageAsset("en")];
	});

	it("marks only the languages no speech bundle ships for, never auto", () => {
		mockStore.state.language = "auto";
		const { container } = render(() => <DictationSettings />);
		expect(optionText(container, "ja")).toBe("Japanese — no spoken replies");
		expect(optionText(container, "it")).toBe("Italian");
		expect(optionText(container, "en")).toBe("English");
		expect(optionText(container, "auto")).toBe("Auto-detect");
	});

	it("warns under the select when the chosen language cannot be spoken back", () => {
		mockStore.state.language = "ja";
		const { container } = render(() => <DictationSettings />);
		const hint = noVoiceHint(container);
		expect(hint).toBeDefined();
		expect(hint!.textContent).toContain("Auto-detect");
		expect(hint!.classList.contains("hint")).toBe(true);
	});

	it("does not warn for a language with a speech bundle, or for auto", () => {
		mockStore.state.language = "it";
		const first = render(() => <DictationSettings />);
		expect(noVoiceHint(first.container)).toBeUndefined();
		first.unmount();
		mockStore.state.language = "auto";
		const { container } = render(() => <DictationSettings />);
		expect(noVoiceHint(container)).toBeUndefined();
	});

	it("claims nothing before the speech catalogue has loaded", () => {
		mockStore.state.language = "ja";
		mockStore.state.speechAssets = [];
		const { container } = render(() => <DictationSettings />);
		expect(optionText(container, "ja")).toBe("Japanese");
		expect(noVoiceHint(container)).toBeUndefined();
	});
});

describe("DictationSettings – layout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue("not_determined");
		mockStore.getDefaultHandsFreeStartNotice.mockResolvedValue("Built-in notice from Rust");
		mockStore.state.notifyModelOnHandsFree = true;
		mockStore.state.handsFreeStartNotice = "";
	});

	/** Which section heading each label renders under, in DOM order. */
	const sectionOf = (container: HTMLElement): Record<string, string> => {
		const owner: Record<string, string> = {};
		let section = "";
		for (const node of Array.from(container.querySelectorAll("h3, label"))) {
			if (node.tagName === "H3") section = node.textContent ?? "";
			else owner[node.textContent ?? ""] = section;
		}
		return owner;
	};

	// Catches: upstream's hands-free conversation or its speech engine offered on
	// the desktop next to FastAF's voice agent — two hands-free systems.
	it("keeps the desktop page to push-to-talk dictation: no hands-free or spoken-reply section", () => {
		const { container } = render(() => <DictationSettings />);
		const headings = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
		expect(headings).toEqual([
			"Dictation",
			"Speech-to-text provider",
			"Speech recognition",
			"Speech assets",
			"AI Rewrite",
			"Auto-Corrections",
		]);
		expect(sectionOf(container).Hotkey).toBe("Dictation");
		expect(container.textContent).not.toContain("Manage Pocket TTS voices");
		expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start conversation")).toBe(
			false,
		);
	});

	// Catches: the hidden card still polling hands-free state or fetching voice
	// lists while the desktop page is open.
	it("starts no hands-free polling or speech-engine fetch on the desktop", async () => {
		mockStore.state.language = "it";
		render(() => <DictationSettings />);
		await Promise.resolve();
		expect(mockStore.refreshHandsFree).not.toHaveBeenCalled();
		expect(mockStore.refreshSpeechStatus).not.toHaveBeenCalled();
		expect(mockStore.refreshSpeechAssets).not.toHaveBeenCalled();
		expect(mockStore.refreshSpeechVoices).not.toHaveBeenCalled();
		expect(mockStore.getDefaultHandsFreeStartNotice).not.toHaveBeenCalled();
		expect(mockInvoke).not.toHaveBeenCalledWith("get_voice_targets", expect.anything());
		expect(mockInvoke).not.toHaveBeenCalledWith("get_voice_targets");
		mockStore.state.language = "auto";
	});

	// Catches: "— no spoken replies" on a desktop language, where replies are
	// spoken by the voice agent and Pocket bundles play no part.
	it("marks no language as unspoken on the desktop", () => {
		const saved = { ...mockStore.state };
		try {
			mockStore.state.speechEngine = "pocket";
			mockStore.state.language = "ja";
			mockStore.state.speechAssets = [
				{
					id: "it",
					display_name: "it",
					kind: "language",
					language: "it",
					voices: [],
					download_bytes: 1,
					state: "ready",
				},
			];
			const { container } = render(() => <DictationSettings />);
			const japanese = Array.from(container.querySelectorAll("option")).find((o) => o.value === "ja");
			expect(japanese?.textContent).toBe("Japanese");
			expect(container.textContent).not.toContain("will not be spoken");
		} finally {
			Object.assign(mockStore.state, saved);
		}
	});

	it("keeps speech-to-text and text-to-speech in separate titled sections in a browser", () => {
		inBrowser();
		const { container } = render(() => <DictationSettings />);
		const headings = Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
		expect(headings).toEqual([
			"Dictation",
			"Speech-to-text provider",
			"Speech recognition",
			"Speech assets",
			"AI Rewrite",
			"Auto-Corrections",
			"Hands-free conversation",
			"Spoken replies",
		]);
	});

	it("puts the desktop's recognition settings under Speech recognition and its assets under Speech assets", () => {
		const owner = sectionOf(render(() => <DictationSettings />).container);
		for (const label of ["Input device", "Language", "Level gate", "Speech confidence gate"]) {
			expect(owner[label]).toBe("Speech recognition");
		}
		expect(owner["Whisper model"]).toBe("Speech assets");
		expect(owner["Voice tuning"]).toBe("Speech assets");
		expect(owner.Voice).toBeUndefined();
	});

	it("puts each side's advanced settings inside its own section, never in a shared one", () => {
		// The speech gates tune recognition, so they belong to it; nothing that
		// tunes recognition may land under the text-to-speech heading.
		inBrowser();
		mockStore.state.language = "it";
		mockStore.state.speechAssets = [
			{
				id: "italian",
				display_name: "Italian",
				kind: "language",
				language: "it",
				voices: ["a", "b"],
				download_bytes: 1,
				state: "ready",
			},
		];
		const owner = sectionOf(render(() => <DictationSettings />).container);
		// A browser has no machine input device: it captures through its own microphone.
		for (const label of ["Language", "Level gate", "Speech confidence gate"]) {
			expect(owner[label]).toBe("Speech recognition");
		}
		expect(owner["Whisper model"]).toBe("Speech assets");
		expect(owner["Voice tuning"]).toBe("Speech assets");
		expect(owner.Voice).toBe("Spoken replies");
	});

	it("keeps the hands-free switches inside the hands-free section", () => {
		inBrowser();
		// The "notify model" toggle only matters while a conversation runs, so it
		// must not sit among the push-to-talk settings at the top.
		const owner = sectionOf(render(() => <DictationSettings />).container);
		for (const label of [
			"Activation phrase",
			"Hold-back before sending",
			"Earcons",
			"Notify model when hands-free changes",
			"Start notice",
		]) {
			expect(owner[label]).toBe("Hands-free conversation");
		}
	});

	it("turns the hands-free earcons off from their own toggle", () => {
		inBrowser();
		const { container } = render(() => <DictationSettings />);
		const group = Array.from(container.querySelectorAll("label"))
			.find((l) => l.textContent === "Earcons")
			?.closest(".settingRow, .group") as HTMLElement;
		const toggle = group.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(toggle.checked).toBe(true);
		fireEvent.change(toggle, { target: { checked: false } });
		expect(mockStore.setHandsFreeEarcons).toHaveBeenCalledWith(false);
	});

	it("suggests “computer” as the activation phrase", () => {
		inBrowser();
		const { container } = render(() => <DictationSettings />);
		const group = Array.from(container.querySelectorAll("label"))
			.find((l) => l.textContent === "Activation phrase")
			?.closest(".settingRow, .group") as HTMLElement;
		expect((group.querySelector('input[type="text"]') as HTMLInputElement).placeholder).toBe("computer");
		expect(group.textContent).toContain("Try “computer”");
	});

	describe("start notice", () => {
		beforeEach(inBrowser);

		// By identity, not position: the AI Rewrite card above also has textareas.
		const noticeField = (container: HTMLElement) =>
			container.querySelector<HTMLTextAreaElement>('textarea[data-setting-id="voice.hands_free_start_notice"]');

		it("shows the built-in text from Rust as the placeholder, never a frontend copy", async () => {
			const { container } = render(() => <DictationSettings />);
			await Promise.resolve();
			await Promise.resolve();
			expect(mockStore.getDefaultHandsFreeStartNotice).toHaveBeenCalledOnce();
			expect(noticeField(container)?.placeholder).toBe("Built-in notice from Rust");
		});

		it("saves an edited notice", () => {
			const { container } = render(() => <DictationSettings />);
			fireEvent.change(noticeField(container) as HTMLTextAreaElement, { target: { value: "Speak Italian." } });
			expect(mockStore.setHandsFreeStartNotice).toHaveBeenCalledWith("Speak Italian.");
		});

		it("resets a custom notice, and offers no reset when the default is already in use", () => {
			mockStore.state.handsFreeStartNotice = "Custom";
			const custom = render(() => <DictationSettings />);
			fireEvent.click(custom.getByText("Reset to default"));
			expect(mockStore.resetHandsFreeStartNotice).toHaveBeenCalledOnce();
			custom.unmount();

			mockStore.state.handsFreeStartNotice = "";
			const builtIn = render(() => <DictationSettings />);
			expect((builtIn.getByText("Reset to default") as HTMLButtonElement).disabled).toBe(true);
		});

		it("is hidden while the model is not notified, because nothing would send it", () => {
			mockStore.state.notifyModelOnHandsFree = false;
			const { container } = render(() => <DictationSettings />);
			expect(noticeField(container)).toBeNull();
		});

		it("still renders when Rust cannot supply the default text", async () => {
			const warning = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
			try {
				mockStore.getDefaultHandsFreeStartNotice.mockRejectedValue(new Error("unknown command"));
				const { container } = render(() => <DictationSettings />);
				await vi.waitFor(() =>
					expect(warning).toHaveBeenCalledExactlyOnceWith(
						"dictation",
						"Failed to load the default hands-free start notice",
					),
				);
				expect(noticeField(container)?.placeholder).toBe("");
			} finally {
				mockStore.getDefaultHandsFreeStartNotice.mockResolvedValue("Built-in notice from Rust");
				warning.mockRestore();
			}
		});
	});
});

// The desktop page is push-to-talk only; a browser adds the hands-free card and
// the spoken-reply engine, and has no machine hotkey or input device.
describe.each([
	{
		client: "desktop",
		expert: ["Long-press threshold", "Auto-send", "Input device", "Level gate", "Speech confidence gate"] as string[],
		basic: ["Enable Dictation", "Hotkey", "Whisper model", "Language"],
	},
	{
		client: "browser",
		expert: [
			"Auto-send",
			"Level gate",
			"Speech confidence gate",
			"Hold-back before sending",
			"Notify model when hands-free changes",
			"Start notice",
			"Speech engine",
			"Voice volume",
			"Levelling",
		] as string[],
		basic: ["Enable Dictation", "Whisper model", "Language", "Activation phrase", "Earcons"],
	},
])("DictationSettings – expert controls ($client)", ({ client: platform, expert, basic }) => {
	// The serialized `DictationConfig::default()` values these controls compare against.
	const DEFAULTS = {
		app: {},
		notifications: {},
		agent_settings: {},
		dictation: {
			long_press_ms: 400,
			auto_send: true,
			device: null,
			rms_threshold: 0.001,
			no_speech_threshold: 0.6,
			hands_free_hold_back_ms: 1500,
			hands_free_notify_model: true,
			hands_free_start_notice: "",
			speech_volume_db: -18,
			speech_levelling: 0.67,
			speech_engine: "pocket",
			speech_command: [],
		},
	};

	type State = typeof mockStore.state;
	/** label → the store field that holds its value and a non-default value for it */
	const EXPERT: Array<[string, keyof State, unknown]> = [
		["Long-press threshold", "longPressMs", 600],
		["Auto-send", "autoSend", false],
		["Input device", "selectedDevice", "USB Mic"],
		["Level gate", "rmsThreshold", 0.01],
		["Speech confidence gate", "noSpeechThreshold", 0.8],
		["Hold-back before sending", "handsFreeHoldBackMs", 0],
		["Notify model when hands-free changes", "notifyModelOnHandsFree", false],
		["Start notice", "handsFreeStartNotice", "Speak Italian."],
		["Speech engine", "speechEngine", "external"],
		["Voice volume", "speechVolumeDb", -24],
		["Levelling", "speechLevelling", 0.2],
	];
	const EXPERT_HERE = EXPERT.filter(([label]) => expert.includes(label));

	const hasLabel = (container: HTMLElement, text: string) =>
		[...container.querySelectorAll("label")].some((el) => el.textContent === text);
	let saved: State;

	beforeEach(async () => {
		vi.clearAllMocks();
		saved = { ...mockStore.state };
		uiStore.setSettingsExpertMode(false);
		mockInvoke.mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "get_config_defaults" ? DEFAULTS : "not_determined"),
		);
		await settingsExpertStore.open();
		if (platform === "browser") inBrowser();
	});

	afterEach(() => {
		Object.assign(mockStore.state, saved);
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
	});

	it("covers every expert control this client renders", () => {
		expect(EXPERT_HERE.map(([label]) => label)).toEqual(expert);
	});

	it("hides every expert control at its default in basic mode and keeps the basic ones", () => {
		const { container } = render(() => <DictationSettings />);
		for (const [label] of EXPERT) expect(hasLabel(container, label), label).toBe(false);
		for (const label of basic) expect(hasLabel(container, label), label).toBe(true);
	});

	it.each(EXPERT_HERE)("shows %s in basic mode once it differs from the default", (label, field, modified) => {
		(mockStore.state as Record<string, unknown>)[field] = modified;
		const { container } = render(() => <DictationSettings />);
		expect(hasLabel(container, label)).toBe(true);
	});

	it.runIf(platform === "browser")(
		"keeps Start notice visible after Reset to default puts it back at the default",
		() => {
			mockStore.state.handsFreeStartNotice = "Speak Italian.";
			const { getByText } = render(() => <DictationSettings />);
			fireEvent.click(getByText("Reset to default"));
			// A click is not an input/change event, so the button must pin the control itself.
			expect(settingsExpertStore.isVisible("dictation.hands_free_start_notice", "")).toBe(true);
		},
	);

	it("shows every expert control at its default in expert mode", async () => {
		uiStore.setSettingsExpertMode(true);
		const { container } = render(() => <DictationSettings />);
		await waitFor(() => {
			for (const [label] of EXPERT_HERE) expect(hasLabel(container, label), label).toBe(true);
		});
	});
});

describe("DictationSettings – Speech engine", () => {
	const labelled = (container: HTMLElement, text: string) =>
		Array.from(container.querySelectorAll("label")).find((el) => el.textContent === text);
	const engineSelect = (container: HTMLElement) =>
		labelled(container, "Speech engine")?.closest(".settingRow, .group")?.querySelector("select") as HTMLSelectElement;

	// Only the keys the engine section compares against; the full set is in the expert describe above.
	const DEFAULTS = {
		app: {},
		notifications: {},
		agent_settings: {},
		dictation: { speech_engine: "pocket", speech_command: [] },
	};

	beforeEach(async () => {
		// Browser-only in FastAF: the desktop speaks through the Voice page.
		inBrowser();
		vi.clearAllMocks();
		mockInvoke.mockImplementation((cmd: string) =>
			Promise.resolve(cmd === "get_config_defaults" ? DEFAULTS : "not_determined"),
		);
		uiStore.setSettingsExpertMode(false);
		await settingsExpertStore.open();
		mockStore.state.speechEngine = "pocket";
		mockStore.state.language = "it";
		mockStore.state.speechCommand = [];
		mockStore.state.speechAssets = [];
	});

	afterEach(() => {
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
		mockStore.state.language = "auto";
	});

	// Catches: Microsoft Edge's online voices offered again, or a handwritten
	// engine list drifting from the owner schema (which refuses "edge").
	it("offers only the engines the owner schema lists, never Microsoft Edge", () => {
		uiStore.setSettingsExpertMode(true);
		const { container } = render(() => <DictationSettings />);
		const options = Array.from(engineSelect(container).options);
		expect(options.map((option) => option.value)).toEqual(["pocket", "external"]);
		expect(options.map((option) => option.textContent)).toEqual([
			"Pocket TTS (local, downloads a model)",
			"External command",
		]);
		expect(container.textContent).not.toMatch(/Microsoft|Edge/);
	});

	it("never asks for the retired Edge voice list", () => {
		render(() => <DictationSettings />);
		expect(mockInvoke).not.toHaveBeenCalledWith("get_edge_voices", expect.anything());
	});

	it("shows no engine switch for a user who never opened Expert", () => {
		const { container } = render(() => <DictationSettings />);
		expect(labelled(container, "Speech engine")).toBeUndefined();
	});

	it("keeps Voice volume and Levelling reachable without any Pocket download", () => {
		// Catches: the sliders staying hidden until a Pocket language bundle exists.
		uiStore.setSettingsExpertMode(true);
		const { container } = render(() => <DictationSettings />);
		expect(labelled(container, "Voice volume")).toBeDefined();
		expect(labelled(container, "Levelling")).toBeDefined();
	});

	it("switches engine from the Expert selector", () => {
		uiStore.setSettingsExpertMode(true);
		const { container } = render(() => <DictationSettings />);
		fireEvent.change(engineSelect(container), { target: { value: "external" } });
		expect(mockStore.setSpeechEngine).toHaveBeenCalledWith("external");
	});

	it("saves the external command as one argument per line and drops blank lines", () => {
		// Catches: a command saved as a single argv element, which would try to
		// run a program named "piper --model x".
		mockStore.state.speechEngine = "external";
		uiStore.setSettingsExpertMode(true);
		const view = render(() => <DictationSettings />);
		const area = view.getByRole("textbox", { name: "Speech command" });
		fireEvent.change(area, { target: { value: "piper\n--output_file\n\n{out}\n" } });
		expect(mockStore.setSpeechCommand).toHaveBeenCalledWith(["piper", "--output_file", "{out}"]);
	});

	it("offers no voice picker for an external command, which names its own voices", () => {
		mockStore.state.speechEngine = "external";
		const { container } = render(() => <DictationSettings />);
		expect(labelled(container, "Voice")).toBeUndefined();
	});
});

describe("hands-free conversation state", () => {
	// Browser-only in FastAF: the desktop speaks through the Voice page.
	beforeEach(inBrowser);

	it("offers an attached AI Chat instead of limiting voice targets to PTYs", async () => {
		mockInvoke.mockImplementation(async (command: string) => {
			if (command === "get_voice_targets")
				return [{ id: "acp:connection:chat", name: "AI Chat · chat", chatSessionId: "chat" }];
			return undefined;
		});
		const view = render(() => <DictationSettings />);
		const option = await view.findByRole("option", { name: "AI Chat · chat" });
		const picker = option.parentElement as HTMLSelectElement;
		fireEvent.change(picker, { target: { value: "acp:connection:chat" } });
		fireEvent.click(view.getByRole("button", { name: "Start conversation" }));
		expect(mockStore.armHandsFree).toHaveBeenCalledWith("acp:connection:chat");
	});

	it("revokes the old voice binding when the target picker changes while armed", async () => {
		mockStore.state.handsFree = { armed: true, phase: "waiting", sessionId: "terminal" };
		mockInvoke.mockImplementation(async (command: string) =>
			command === "get_voice_targets"
				? [{ id: "acp:connection:chat", name: "AI Chat · chat", chatSessionId: "chat" }]
				: undefined,
		);
		const view = render(() => <DictationSettings />);
		const option = await view.findByRole("option", { name: "AI Chat · chat" });
		mockStore.disarmHandsFree.mockClear();
		fireEvent.change(option.parentElement!, { target: { value: "acp:connection:chat" } });
		expect(mockStore.disarmHandsFree).toHaveBeenCalledOnce();
	});

	afterEach(() => {
		mockStore.state.handsFree = null;
	});

	it("shows Stopped before status arrives so opening settings does not imply a running microphone", () => {
		mockStore.state.handsFree = null;
		const view = render(() => <DictationSettings />);
		expect(view.getByRole("status").textContent).toContain("Stopped");
		expect(view.getByRole("button", { name: "Start conversation" })).toBeDefined();
		expect(view.queryByRole("button", { name: "Stop conversation" })).toBeNull();
	});

	it("shows Running and Stop for an armed conversation instead of the start action", () => {
		mockStore.state.handsFree = { armed: true, phase: "waiting" };
		const view = render(() => <DictationSettings />);
		expect(view.getByRole("status").textContent).toContain("Running");
		fireEvent.click(view.getByRole("button", { name: "Stop conversation" }));
		expect(mockStore.disarmHandsFree).toHaveBeenCalled();
		expect(view.queryByRole("button", { name: "Start conversation" })).toBeNull();
	});
});
