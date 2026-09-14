import { onCleanup } from "solid-js";

/**
 * Run `onHide` / `onShow` when the page crosses between hidden and visible.
 *
 * Edge-triggered on purpose: `visibilitychange` also fires for transitions the
 * page has already accounted for, and a caller that pairs a stop with a start
 * must not see two stops in a row.
 *
 * Must be called inside a reactive root — the listener is released via
 * `onCleanup`.
 */
export function createVisibilityGate(onHide: () => void, onShow: () => void): void {
	let hidden = document.visibilityState === "hidden";

	const sync = () => {
		const nowHidden = document.visibilityState === "hidden";
		if (nowHidden === hidden) return;
		hidden = nowHidden;
		if (hidden) onHide();
		else onShow();
	};

	document.addEventListener("visibilitychange", sync);
	onCleanup(() => document.removeEventListener("visibilitychange", sync));
}
