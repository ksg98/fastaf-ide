import { createEffect, onCleanup, type Setter } from "solid-js";
import { isQuickSwitcherActive, isQuickSwitcherRelease } from "../platform";

/** Tracks modifier hold state for the quick-switcher overlay. */
export function useQuickSwitcherVisibility(setVisible: Setter<boolean>): void {
	createEffect(() => {
		const trackKeydown = (event: KeyboardEvent) => {
			if (isQuickSwitcherActive(event)) setVisible(true);
		};
		const trackKeyup = (event: KeyboardEvent) => {
			if (isQuickSwitcherRelease(event)) setVisible(false);
		};
		const dismiss = () => setVisible(false);
		document.addEventListener("keydown", trackKeydown);
		document.addEventListener("keyup", trackKeyup);
		window.addEventListener("blur", dismiss);
		document.addEventListener("visibilitychange", dismiss);
		onCleanup(() => {
			document.removeEventListener("keydown", trackKeydown);
			document.removeEventListener("keyup", trackKeyup);
			window.removeEventListener("blur", dismiss);
			document.removeEventListener("visibilitychange", dismiss);
		});
	});
}
