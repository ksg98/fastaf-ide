import { createEffect, onCleanup } from "solid-js";
import { type ShortcutHandlers, useKeyboardShortcuts } from "./useKeyboardShortcuts";

/** Re-registers global shortcuts when their reactive keybinding inputs change. */
export function useShortcutRegistration(handlers: ShortcutHandlers): void {
	createEffect(() => {
		const cleanup = useKeyboardShortcuts(handlers);
		onCleanup(cleanup);
	});
}
