import { createEffect, onCleanup } from "solid-js";

export interface OutsideDismissOptions {
	/** Elements whose descendants are "inside"; undefined entries (unmounted refs) are skipped. */
	inside: () => (Element | undefined)[];
	onClose: () => void;
	/** Listener is attached only while this is true. Defaults to always. */
	enabled?: () => boolean;
	/** Presses on a matching element (e.g. the trigger that toggles the popup) are not outside presses. */
	ignoreSelector?: string;
}

/**
 * Dismiss a non-modal popup on a pointer press outside it.
 *
 * Capture-phase document listener that never consumes the event: a transparent
 * full-window backdrop would instead swallow wheel and clicks over everything
 * underneath (sidebar, terminal) while the popup is open.
 */
export function useOutsideDismiss(options: OutsideDismissOptions): void {
	createEffect(() => {
		if (!(options.enabled?.() ?? true)) return;
		const handler = (e: PointerEvent) => {
			const target = e.target;
			if (!(target instanceof Element)) return;
			if (options.inside().some((el) => el?.contains(target))) return;
			if (options.ignoreSelector && target.closest(options.ignoreSelector)) return;
			options.onClose();
		};
		document.addEventListener("pointerdown", handler, true);
		onCleanup(() => document.removeEventListener("pointerdown", handler, true));
	});
}
