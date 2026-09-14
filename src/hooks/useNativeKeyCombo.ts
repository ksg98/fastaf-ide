import { createEffect, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { isTauri } from "../transport";

/** Payload of the Rust `native-key-down` event (see `src-tauri/src/native_keys.rs`). */
interface NativeKeyDown {
	key: string;
	cmd: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

/**
 * Build the combo string for a natively-captured key.
 *
 * Deliberately mirrors `keyEventToCombo`'s modifier order (Cmd, Ctrl, Alt, Shift) so a
 * combo recorded via the native path is byte-identical to one recorded from a DOM event
 * — they are compared against each other for conflicts and persisted to the same store.
 *
 * Unlike `keyEventToCombo` there is no platform branch: this event only exists on macOS,
 * where Cmd is Command and Ctrl is Control.
 */
export function nativeKeyToCombo(payload: NativeKeyDown): string {
	const modifiers: string[] = [];
	if (payload.cmd) modifiers.push("Cmd");
	if (payload.ctrl) modifiers.push("Ctrl");
	if (payload.alt) modifiers.push("Alt");
	if (payload.shift) modifiers.push("Shift");
	return [...modifiers, payload.key].join("+");
}

/**
 * Feed natively-captured keys into a shortcut recorder.
 *
 * macOS never delivers F13-F20 to WKWebView, so a `keydown` listener sees nothing at all
 * and those keys look unbindable even though every layer below accepts them. Rust catches
 * them with an NSEvent monitor and re-emits them; this hook turns that back into the same
 * combo string the DOM path produces.
 *
 * @param active   Whether a recording session is currently open. The listener is only
 *                 attached while recording, so these keys keep their normal behaviour
 *                 everywhere else in the app.
 * @param onCombo  Receives the combo, exactly as `keyEventToCombo` would have returned it.
 */
export function useNativeKeyCombo(active: () => boolean, onCombo: (combo: string) => void): void {
	createEffect(() => {
		if (!active() || !isTauri()) return;

		let cancelled = false;
		let unlisten: (() => void) | undefined;

		listen<NativeKeyDown>("native-key-down", (event) => {
			const payload = event.payload;
			if (!payload?.key) return;
			onCombo(nativeKeyToCombo(payload));
		})
			.then((dispose) => {
				// The effect can re-run (or the session can close) before listen() resolves.
				cancelled ? dispose() : (unlisten = dispose);
			})
			.catch((error) => appLogger.error("config", "Failed to listen for native-key-down", error));

		onCleanup(() => {
			cancelled = true;
			unlisten?.();
		});
	});
}
