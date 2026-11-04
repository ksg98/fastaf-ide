import { createSignal } from "solid-js";
import { appLogger } from "./appLogger";

const KEY = "tui-commander-new-text-indicator";

function loadEnabled(): boolean {
	try {
		return localStorage.getItem(KEY) !== "false";
	} catch {
		return true;
	}
}

// A per-client view preference, shared by terminal Chat and AI Chat.
const [enabled, setEnabled] = createSignal(loadEnabled());
export const transcriptPreferences = {
	enabled,
	setEnabled(value: boolean): void {
		setEnabled(value);
		try {
			localStorage.setItem(KEY, String(value));
		} catch (error) {
			appLogger.warn("store", "Failed to persist new-text indicator preference", error);
		}
	},
};
