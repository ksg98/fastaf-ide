import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
	localStorage.clear();
});

// Catches: opting out working only until a client reload, or an unset preference disabling the feature.
it("defaults the indicator on and restores a saved opt-out after reload", async () => {
	const { transcriptPreferences } = await import("../../stores/transcriptPreferences");
	expect(transcriptPreferences.enabled()).toBe(true);
	transcriptPreferences.setEnabled(false);
	vi.resetModules();
	const reloaded = (await import("../../stores/transcriptPreferences")).transcriptPreferences;
	expect(reloaded.enabled()).toBe(false);
	reloaded.setEnabled(true);
	vi.resetModules();
	expect((await import("../../stores/transcriptPreferences")).transcriptPreferences.enabled()).toBe(true);
});
