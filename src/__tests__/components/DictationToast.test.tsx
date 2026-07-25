import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testInScopeAsync } from "../helpers/store";
// Must import mocks before store/component
import { mockInvoke } from "../mocks/tauri";

describe("DictationToast", () => {
	let DictationToast: typeof import("../../components/DictationToast/DictationToast").DictationToast;
	let dictationStore: typeof import("../../stores/dictation").dictationStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		const storeModule = await import("../../stores/dictation");
		dictationStore = storeModule.dictationStore;
		const component = await import("../../components/DictationToast/DictationToast");
		DictationToast = component.DictationToast;
	});

	it("is hidden by default", () => {
		const { container } = render(() => <DictationToast />);
		expect(container.querySelector(".toast")).toBeNull();
	});

	it("shows the live preview and an idle meter when recording starts", async () => {
		// Mock start_dictation to succeed
		mockInvoke.mockResolvedValueOnce(undefined);

		await testInScopeAsync(async () => {
			const { container } = render(() => <DictationToast />);

			// Start recording (sets recording=true in store)
			await dictationStore.startRecording();
			expect(dictationStore.state.recording).toBe(true);

			expect(container.querySelector(".toast")).not.toBeNull();
			expect(container.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");

			mockInvoke.mockResolvedValueOnce({ text: "", skip_reason: "no speech detected", duration_s: 0 });
			await dictationStore.stopRecording();
		});
	});

	it("hides toast after recording stops", async () => {
		mockInvoke.mockResolvedValueOnce(undefined); // start_dictation

		await testInScopeAsync(async () => {
			render(() => <DictationToast />);

			await dictationStore.startRecording();
			expect(dictationStore.state.recording).toBe(true);

			// Stop recording
			mockInvoke.mockResolvedValueOnce({ text: "hello", skip_reason: null, duration_s: 1.0 });
			await dictationStore.stopRecording();

			expect(dictationStore.state.recording).toBe(false);
			expect(dictationStore.state.partialText).toBe("");
		});
	});
});
