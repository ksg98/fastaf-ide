import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => {
	const store = {
		state: {
			config: {
				model: "q8f16",
				voice: "af_heart",
				speed: 1,
				barge_in: false,
				output_device: null as string | null,
			},
			models: [
				{
					name: "q8f16",
					display_name: "Kokoro 82M (quantized)",
					size_hint_mb: 86,
					downloaded: false,
					actual_size_mb: 0,
				},
				{
					name: "fp32",
					display_name: "Kokoro 82M (full precision)",
					size_hint_mb: 326,
					downloaded: false,
					actual_size_mb: 0,
				},
			],
			voices: [
				{ id: "af_heart", display_name: "Heart (US, female)", downloaded: false },
				{ id: "am_michael", display_name: "Michael (US, male)", downloaded: false },
			],
			outputDevices: [{ name: "MacBook Pro Speakers", is_default: true }],
			engineState: "stopped",
			loadedModel: null as string | null,
			sessionActive: false,
			agentState: "idle" as const,
			audioLevel: 0,
			downloading: null as string | null,
			downloadPercent: 0,
			loadingEngine: false,
			error: "",
		},
		refreshConfig: vi.fn().mockResolvedValue(undefined),
		refreshModels: vi.fn().mockResolvedValue(undefined),
		refreshStatus: vi.fn().mockResolvedValue(undefined),
		refreshOutputDevices: vi.fn().mockResolvedValue(undefined),
		saveConfig: vi.fn().mockResolvedValue(undefined),
		downloadModel: vi.fn().mockResolvedValue(undefined),
		downloadVoice: vi.fn().mockResolvedValue(undefined),
		deleteModel: vi.fn().mockResolvedValue(undefined),
		deleteVoice: vi.fn().mockResolvedValue(undefined),
		loadEngine: vi.fn().mockResolvedValue(undefined),
		unloadEngine: vi.fn().mockResolvedValue(undefined),
	};
	return { store };
});

vi.mock("../../stores/voice", () => ({ voiceStore: store }));

import { VoiceTab } from "../../components/SettingsPanel/tabs/VoiceTab";

/** Reset to the "nothing downloaded yet" baseline before each test. */
beforeEach(() => {
	vi.clearAllMocks();
	store.state.config = {
		model: "q8f16",
		voice: "af_heart",
		speed: 1,
		barge_in: false,
		output_device: null,
	};
	store.state.models = store.state.models.map((m) => ({
		...m,
		downloaded: false,
		actual_size_mb: 0,
	}));
	store.state.voices = store.state.voices.map((v) => ({ ...v, downloaded: false }));
	store.state.engineState = "stopped";
	store.state.loadedModel = null;
	store.state.sessionActive = false;
	store.state.downloading = null;
	store.state.downloadPercent = 0;
	store.state.error = "";
});

afterEach(cleanup);

describe("VoiceTab", () => {
	it("loads config, models, status and devices on mount", () => {
		render(() => <VoiceTab />);
		expect(store.refreshConfig).toHaveBeenCalledOnce();
		expect(store.refreshModels).toHaveBeenCalledOnce();
		expect(store.refreshStatus).toHaveBeenCalledOnce();
		expect(store.refreshOutputDevices).toHaveBeenCalledOnce();
	});

	it("offers the estimated size before download and the real size after", () => {
		const { unmount } = render(() => <VoiceTab />);
		expect(screen.getByText("~86 MB")).toBeTruthy();
		unmount();

		store.state.models = store.state.models.map((m) =>
			m.name === "q8f16" ? { ...m, downloaded: true, actual_size_mb: 82 } : m,
		);
		render(() => <VoiceTab />);
		expect(screen.getByText("82 MB")).toBeTruthy();
	});

	it("downloads the model that was clicked", () => {
		render(() => <VoiceTab />);
		const downloads = screen.getAllByText("Download");
		fireEvent.click(downloads[1]); // the fp32 row
		expect(store.downloadModel).toHaveBeenCalledWith("fp32");
	});

	it("shows progress only on the row being downloaded", () => {
		store.state.downloading = "fp32";
		store.state.downloadPercent = 42;
		render(() => <VoiceTab />);
		expect(screen.getAllByText("42%")).toHaveLength(1);
	});

	it("marks the configured model active and offers to switch to the other", () => {
		store.state.models = store.state.models.map((m) => ({ ...m, downloaded: true }));
		render(() => <VoiceTab />);

		expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
		fireEvent.click(screen.getAllByText("Use")[0]);
		expect(store.saveConfig).toHaveBeenCalledWith({ model: "fp32" });
	});

	it("deletes a downloaded model", () => {
		store.state.models = store.state.models.map((m) =>
			m.name === "q8f16" ? { ...m, downloaded: true, actual_size_mb: 82 } : m,
		);
		render(() => <VoiceTab />);
		fireEvent.click(screen.getAllByTitle("Delete download")[0]);
		expect(store.deleteModel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(store.deleteModel).toHaveBeenCalledWith("q8f16");
	});

	it("fetches an undownloaded voice before selecting it, so one click is enough", async () => {
		render(() => <VoiceTab />);
		// Two rows offer it in the baseline: the selected-but-missing default
		// and the never-selected one. The second is Michael.
		fireEvent.click(screen.getAllByText("Get & use")[1]);
		await Promise.resolve();
		expect(store.downloadVoice).toHaveBeenCalledWith("am_michael");
		expect(store.saveConfig).toHaveBeenCalledWith({ voice: "am_michael" });
	});

	it("never marks a voice Active while its file is missing", async () => {
		// The #6 trap: af_heart is the configured default on a fresh install,
		// with nothing on disk. That must read as something to fetch, not as a
		// working setup.
		const { unmount } = render(() => <VoiceTab />);
		expect(screen.queryByText("Active")).toBeNull();
		fireEvent.click(screen.getAllByText("Get & use")[0]);
		await Promise.resolve();
		expect(store.downloadVoice).toHaveBeenCalledWith("af_heart");
		unmount();

		// Once the file exists, the selected voice is Active and the fetch
		// button is gone.
		store.state.voices = store.state.voices.map((v) => (v.id === "af_heart" ? { ...v, downloaded: true } : v));
		render(() => <VoiceTab />);
		expect(screen.getByText("Active")).toBeTruthy();
		expect(screen.getAllByText("Get & use")).toHaveLength(1);
	});

	it("offers Load when the engine is cold and Unload once it is resident", () => {
		const { unmount } = render(() => <VoiceTab />);
		expect(screen.getByText("Not loaded")).toBeTruthy();
		fireEvent.click(screen.getByText("Load"));
		expect(store.loadEngine).toHaveBeenCalledOnce();
		unmount();

		store.state.engineState = "ready";
		store.state.loadedModel = "q8f16";
		render(() => <VoiceTab />);
		expect(screen.getByText("Loaded in memory")).toBeTruthy();
		fireEvent.click(screen.getByText("Unload"));
		expect(store.unloadEngine).toHaveBeenCalledOnce();
	});

	it("refuses to unload while a session is running", () => {
		store.state.engineState = "ready";
		store.state.sessionActive = true;
		render(() => <VoiceTab />);
		const unload = screen.getByText("Unload") as HTMLButtonElement;
		expect(unload.disabled).toBe(true);
		expect(unload.title).toContain("Stop the voice session first");
	});

	it("saves the speaking rate as a multiplier, not a percentage", () => {
		render(() => <VoiceTab />);
		const slider = screen.getByRole("slider") as HTMLInputElement;
		fireEvent.input(slider, { target: { value: "150" } });
		expect(store.saveConfig).toHaveBeenCalledWith({ speed: 1.5 });
	});

	it("treats the empty output device as the system default", () => {
		render(() => <VoiceTab />);
		const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
		fireEvent.change(selects[0], { target: { value: "" } });
		expect(store.saveConfig).toHaveBeenCalledWith({ output_device: null });
	});

	it("reflects barge-in state and can turn it off", () => {
		store.state.config.barge_in = true;
		render(() => <VoiceTab />);
		const toggle = screen.getByRole("checkbox") as HTMLInputElement;
		expect(toggle.checked).toBe(true);
		// The hint must not still tell people to use headphones — echo
		// cancellation is what removed that caveat.
		expect(screen.queryByText(/use headphones/i)).toBeNull();

		fireEvent.click(toggle);
		expect(store.saveConfig).toHaveBeenCalledWith({ barge_in: false });
	});

	it("warns while the selected model is missing, and stops once it is present", () => {
		const { unmount } = render(() => <VoiceTab />);
		expect(screen.getByText(/Download the speech model/)).toBeTruthy();
		unmount();

		store.state.models = store.state.models.map((m) => ({ ...m, downloaded: true }));
		store.state.voices = store.state.voices.map((v) => ({ ...v, downloaded: true }));
		render(() => <VoiceTab />);
		expect(screen.queryByText(/Download the speech model/)).toBeNull();
		expect(screen.queryByText(/Download the selected voice/)).toBeNull();
	});

	it("warns separately when only the voice is missing", () => {
		store.state.models = store.state.models.map((m) => ({ ...m, downloaded: true }));
		render(() => <VoiceTab />);
		expect(screen.getByText(/Download the selected voice/)).toBeTruthy();
	});

	it("surfaces a store error", () => {
		store.state.error = "Kokoro 82M (quantized) is not downloaded";
		render(() => <VoiceTab />);
		expect(screen.getByText("Kokoro 82M (quantized) is not downloaded")).toBeTruthy();
	});
});
