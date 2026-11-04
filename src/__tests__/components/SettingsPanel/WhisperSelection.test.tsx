import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "../../../components/SettingsPanel/SettingsPanel";
import { appLogger } from "../../../stores/appLogger";
import { dictationStore, type ModelInfo } from "../../../stores/dictation";
import { mockInvoke } from "../../mocks/tauri";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("keeps the configured Whisper choice when the async catalogue replaces its fallback in SettingsPanel", async () => {
	// Catches: the picker moving to another model when the catalogue arrives,
	// while the real store still names the configured one. FastAF picks the
	// model on its own row ("Use"), so the configured row must stay the active one.
	let finishCatalogue!: (models: ModelInfo[]) => void;
	const catalogue = new Promise<ModelInfo[]>((resolve) => {
		finishCatalogue = resolve;
	});
	const errors = vi.spyOn(appLogger, "error").mockImplementation(() => {});
	mockInvoke.mockImplementation(async (command: string) => {
		switch (command) {
			case "get_model_info":
				return catalogue;
			case "get_dictation_config":
				return { enabled: false, hotkey: "F5", language: "auto", model: "large-v3-turbo", speech_engine: "edge" };
			case "get_dictation_status":
				return { model_status: "not_downloaded", model_name: "large-v3-turbo", model_size_mb: 0 };
			case "get_speech_assets":
				return [];
			case "get_hands_free_status":
				return { armed: false, phase: "disarmed", sessionId: null, owner: null };
			case "get_speech_status":
				return null;
			case "check_microphone_permission":
				return "not_determined";
			// FastAF's dictation page also reads the provider registry (AI rewrite).
			case "load_provider_registry":
				return { schema_version: 3, providers: [], models: [], slots: {}, features: {} };
			default:
				return {};
		}
	});

	const view = render(() => <SettingsPanel visible onClose={() => {}} initialTab="dictation" />);
	finishCatalogue([
		{ name: "small", display_name: "Small", size_hint_mb: 488, downloaded: true, actual_size_mb: 488 },
		{
			name: "large-v3-turbo",
			display_name: "Large V3 Turbo",
			size_hint_mb: 1620,
			downloaded: false,
			actual_size_mb: 0,
		},
	]);
	const row = (name: string) => view.container.querySelector<HTMLElement>(`[data-whisper-model="${name}"]`);
	await waitFor(() => expect(row("large-v3-turbo")).not.toBeNull());
	expect(dictationStore.state.selectedModel).toBe("large-v3-turbo");
	expect(row("large-v3-turbo")?.classList.contains("active")).toBe(true);
	expect(row("small")?.classList.contains("active")).toBe(false);
	// The other downloaded model is offered, not chosen.
	expect(row("small")?.textContent).toContain("Use");
	expect(mockInvoke.mock.calls.some(([command]) => command === "save_dictation_config")).toBe(false);
	expect(errors).not.toHaveBeenCalled();
});
