import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createSignal, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";

export interface PanelSnapshot<T = unknown> {
	panelId: string;
	ts: number;
	snapshot: T;
}

export interface PanelAction {
	panelId: string;
	action: string;
	data: unknown;
}

export function createPanelSyncReceiver<T>(panelId: string) {
	const [state, setState] = createSignal<T | null>(null);
	let lastTs = 0;

	const cleanups: (() => void)[] = [];

	// Use window-scoped listen — emitTo targets a specific window,
	// so the global listen (broadcast only) won't receive these events.
	const win = getCurrentWebviewWindow();
	win
		.listen<PanelSnapshot<T>>("panel-sync", (event) => {
			if (event.payload.panelId !== panelId) return;
			if (event.payload.ts <= lastTs) return;
			lastTs = event.payload.ts;
			setState(() => event.payload.snapshot);
		})
		.then((fn) => cleanups.push(fn))
		.catch((e) => appLogger.error("panel-sync", `Failed to register panel-sync listener for ${panelId}`, e));

	const onVisChange = () => {
		if (!document.hidden) {
			emitTo("main", "panel-resync-request", { panelId });
		}
	};
	document.addEventListener("visibilitychange", onVisChange);
	cleanups.push(() => document.removeEventListener("visibilitychange", onVisChange));

	function destroy() {
		for (const fn of cleanups) fn();
		cleanups.length = 0;
	}

	onCleanup(destroy);

	async function emitAction(action: string, data: unknown) {
		await emitTo("main", "panel-action", { panelId, action, data });
	}

	return { state, emitAction, destroy };
}

export function createPanelSyncProvider(panelId: string, serialize: () => unknown, intervalMs: number) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let resyncUnlisten: (() => void) | undefined;
	let pushCount = 0;
	let lastEncoded: string | undefined;
	/** Ordinal of the newest snapshot known to have been delivered. */
	let lastDelivered = 0;

	/**
	 * Emit a snapshot to the detached window.
	 *
	 * Skipped when the snapshot is byte-identical to the last one sent: the
	 * receiver replaces its whole state on every frame, so an unchanged push
	 * costs a full IPC serialization plus a full DOM rebuild for no change.
	 * `force` bypasses the check for the cases where the peer's copy is unknown
	 * (first push after start, and an explicit resync request).
	 */
	function push(force = false) {
		const snapshot = serialize();
		const encoded = JSON.stringify(snapshot);
		if (!force && encoded === lastEncoded) return;

		pushCount++;
		const label = `panel-${panelId}`;
		const count = pushCount;
		emitTo(label, "panel-sync", {
			panelId,
			ts: Date.now(),
			snapshot,
		})
			// Only a delivered snapshot is the peer's state. Recording it before
			// the emit resolved made a failure permanent: the first push happens
			// while the detached window may not be addressable yet, and every
			// later interval then suppressed that same unchanged snapshot as
			// already sent, leaving the panel empty until an explicit resync.
			.then(() => {
				// Two pushes can be in flight; the older one resolving last must
				// not name an older snapshot as the peer's state, or a return to
				// that snapshot is suppressed while the peer holds a newer one.
				if (count < lastDelivered) return;
				lastDelivered = count;
				lastEncoded = encoded;
			})
			.catch((e) => {
				if (count > 1) {
					appLogger.warn("panel-sync", `Failed to push snapshot to ${label}`, e);
				}
			});
	}

	function start() {
		if (timer) return;
		listen<{ panelId: string }>("panel-resync-request", (e) => {
			if (e.payload.panelId === panelId) push(true);
		})
			.then((fn) => {
				resyncUnlisten = fn;
			})
			.catch((e) => appLogger.error("panel-sync", `Failed to register resync listener for ${panelId}`, e));
		push(true);
		timer = setInterval(() => push(), intervalMs);
	}

	function stop() {
		clearInterval(timer);
		timer = undefined;
		resyncUnlisten?.();
		resyncUnlisten = undefined;
	}

	return { start, stop, push };
}
