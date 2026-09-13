import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("../../stores/dictation", () => ({
	dictationStore: mockStore,
	WHISPER_LANGUAGES: { auto: "Auto-detect", en: "English" },
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
