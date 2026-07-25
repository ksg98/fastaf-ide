import { createEffect, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { dictationStore } from "../stores/dictation";
import { isTauri } from "../transport";
import { createLongPressHandlerFromHotkey } from "./useLongPressHotkey";

interface DictationHotkeyOptions {
	onStart: () => void;
	onStop: () => void;
}

/** Owns native Fn and DOM key lifecycles for push-to-talk dictation. */
export function useDictationHotkey(options: DictationHotkeyOptions): void {
	createEffect(() => {
		const hotkey = dictationStore.state.hotkey;
		const capturing = dictationStore.state.capturingHotkey;
		const longPressMs = dictationStore.state.longPressMs;
		if (!dictationStore.state.enabled || !hotkey || capturing) return;

		const handler = createLongPressHandlerFromHotkey(hotkey, longPressMs, {
			onStart: options.onStart,
			onStop: options.onStop,
		});
		if (!handler) return;

		let cleanupListeners: () => void;
		if (hotkey === "Fn") {
			let cancelled = false;
			let unlistenDown: (() => void) | undefined;
			let unlistenUp: (() => void) | undefined;
			if (isTauri()) {
				listen("fn-key-down", () => handler.handleEvent({ eventType: "KeyPress", key: "Fn" }))
					.then((dispose) => {
						cancelled ? dispose() : (unlistenDown = dispose);
					})
					.catch((error) => appLogger.error("dictation", "Failed to listen for fn-key-down", error));
				listen("fn-key-up", () => handler.handleEvent({ eventType: "KeyRelease", key: "Fn" }))
					.then((dispose) => {
						cancelled ? dispose() : (unlistenUp = dispose);
					})
					.catch((error) => appLogger.error("dictation", "Failed to listen for fn-key-up", error));
			}
			cleanupListeners = () => {
				cancelled = true;
				unlistenDown?.();
				unlistenUp?.();
			};
		} else {
			const hasModifiers = hotkey.includes("+");
			const onKeyDown = (event: KeyboardEvent) => {
				const consumed = handler.handleEvent({ eventType: "KeyPress", key: event.code });
				if (consumed && (hasModifiers || event.repeat)) event.preventDefault();
			};
			const onKeyUp = (event: KeyboardEvent) => {
				handler.handleEvent({ eventType: "KeyRelease", key: event.code });
			};
			window.addEventListener("keydown", onKeyDown);
			window.addEventListener("keyup", onKeyUp);
			cleanupListeners = () => {
				window.removeEventListener("keydown", onKeyDown);
				window.removeEventListener("keyup", onKeyUp);
			};
		}

		onCleanup(() => {
			handler.cleanup();
			cleanupListeners();
		});
	});
}
