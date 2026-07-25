import { createEffect, onCleanup, untrack } from "solid-js";
import { invoke, listen } from "../invoke";
import { panelRegistry } from "../panelRouter";
import { appLogger } from "../stores/appLogger";
import { uiStore } from "../stores/ui";
import { isTauri } from "../transport";
import { createPanelSyncProvider, type PanelAction } from "../utils/panelSync";

/** Owns main-window listeners, projection sync providers, and detached-window restoration. */
export function useDetachedPanelBridge(): { restoreDetachedPanels: () => void } {
	let unlistenClosed: (() => void) | undefined;
	listen<string>("panel-window-closed", (event) => {
		const panelId = event.payload;
		uiStore.clearDetached(panelId);
		panelRegistry[panelId]?.toggle?.();
	}).then((unlisten) => {
		unlistenClosed = unlisten;
	});
	onCleanup(() => unlistenClosed?.());

	let unlistenAction: (() => void) | undefined;
	listen<PanelAction>("panel-action", (event) => {
		const { panelId, action, data } = event.payload;
		if (action === "reattach") {
			uiStore.clearDetached(panelId);
			panelRegistry[panelId]?.toggle?.();
			return;
		}
		panelRegistry[panelId]?.handleAction?.(action, data);
	}).then((unlisten) => {
		unlistenAction = unlisten;
	});
	onCleanup(() => unlistenAction?.());

	for (const adapter of Object.values(panelRegistry)) {
		if (!adapter.serialize || !adapter.syncIntervalMs) continue;
		const projection = adapter;
		createEffect(() => {
			if (!uiStore.isDetached(projection.id)) return;
			const provider = untrack(() => {
				const next = createPanelSyncProvider(projection.id, projection.serialize!, projection.syncIntervalMs!);
				next.start();
				return next;
			});
			onCleanup(() => provider.stop());
		});
	}

	const restoreDetachedPanels = () => {
		if (!isTauri()) return;
		const panels = { ...uiStore.state.detachedPanels };
		for (const panelId of Object.keys(panels)) {
			const adapter = panelRegistry[panelId];
			if (!adapter) {
				uiStore.clearDetached(panelId);
				continue;
			}
			invoke("open_panel_window", {
				panelId,
				title: adapter.title,
				params: {},
				width: adapter.defaultSize.width,
				height: adapter.defaultSize.height,
			}).catch((err) => {
				appLogger.warn("app", `Failed to restore detached panel: ${panelId}`, { error: String(err) });
				uiStore.clearDetached(panelId);
			});
		}
	};

	return { restoreDetachedPanels };
}
