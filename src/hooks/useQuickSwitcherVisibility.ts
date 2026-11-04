import { createEffect, onCleanup, type Setter } from "solid-js";
import { isMacOS, isQuickSwitcherActive, isQuickSwitcherRelease } from "../platform";

/** Tracks the quick-switcher chord and the independent primary-modifier tab hints. */
export function useQuickSwitcherVisibility(setVisible: Setter<boolean>, setTabHintsVisible?: Setter<boolean>): void {
	createEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let primaryHeld = false;
		const cancelTabHints = () => {
			clearTimeout(timer);
			timer = undefined;
			setTabHintsVisible?.(false);
		};
		const trackKeydown = (event: KeyboardEvent) => {
			if (isQuickSwitcherActive(event)) setVisible(true);
			const primary = isMacOS() ? "Meta" : "Control";
			const alone =
				event.key === primary &&
				!event.altKey &&
				!event.shiftKey &&
				(isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
			if (!alone) {
				cancelTabHints();
				return;
			}
			if (primaryHeld || event.repeat) return;
			primaryHeld = true;
			if (setTabHintsVisible)
				timer = setTimeout(() => {
					timer = undefined;
					setTabHintsVisible(true);
				}, 450);
		};
		const trackKeyup = (event: KeyboardEvent) => {
			if (isQuickSwitcherRelease(event)) setVisible(false);
			if (event.key === (isMacOS() ? "Meta" : "Control")) {
				primaryHeld = false;
				cancelTabHints();
			}
		};
		const dismiss = () => {
			primaryHeld = false;
			cancelTabHints();
			setVisible(false);
		};
		document.addEventListener("keydown", trackKeydown, true);
		document.addEventListener("keyup", trackKeyup, true);
		document.addEventListener("mousedown", cancelTabHints, true);
		document.addEventListener("wheel", cancelTabHints, { capture: true, passive: true });
		window.addEventListener("blur", dismiss);
		document.addEventListener("visibilitychange", dismiss);
		onCleanup(() => {
			clearTimeout(timer);
			document.removeEventListener("keydown", trackKeydown, true);
			document.removeEventListener("keyup", trackKeyup, true);
			document.removeEventListener("mousedown", cancelTabHints, true);
			document.removeEventListener("wheel", cancelTabHints, true);
			window.removeEventListener("blur", dismiss);
			document.removeEventListener("visibilitychange", dismiss);
		});
	});
}
