import { createEffect, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { terminalsStore } from "../stores/terminals";
import { isTauri } from "../transport";

interface TerminalReattachBridgeOptions {
	reattach: (tabId: string) => void;
	setStatusInfo: (message: string) => void;
}

/** Routes native floating-window close events back to the main terminal workspace. */
export function useTerminalReattachBridge(options: TerminalReattachBridgeOptions): void {
	createEffect(() => {
		if (!isTauri()) return;
		let unlisten: (() => void) | undefined;

		listen<{ tabId: string; sessionId: string }>("reattach-terminal", (event) => {
			const { tabId } = event.payload;
			if (!terminalsStore.isDetached(tabId)) return;
			options.reattach(tabId);
			options.setStatusInfo("Tab reattached");
			setTimeout(() => {
				const ref = terminalsStore.get(tabId)?.ref;
				if (ref) {
					ref.refresh();
					ref.fit();
				}
			}, 150);
		})
			.then((dispose) => {
				unlisten = dispose;
			})
			.catch((error) => appLogger.error("terminal", "Failed to listen for reattach events", error));

		onCleanup(() => unlisten?.());
	});
}
