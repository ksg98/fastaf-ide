import { createSignal, onCleanup } from "solid-js";

const KEY = "tuic-mobile-keyboard-correction";
const CHANGED = "tuic-mobile-keyboard-correction-changed";

/** Device-local, like mobile sound and keep-awake preferences. No server config. */
export function useKeyboardCorrection() {
	const read = () => localStorage.getItem(KEY) !== "false";
	const [enabled, setEnabled] = createSignal(read());
	const refresh = () => setEnabled(read());
	window.addEventListener(CHANGED, refresh);
	onCleanup(() => window.removeEventListener(CHANGED, refresh));

	return {
		enabled,
		toggle() {
			localStorage.setItem(KEY, String(!enabled()));
			window.dispatchEvent(new Event(CHANGED));
		},
	};
}
