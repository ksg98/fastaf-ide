import { createEffect, onCleanup, onMount } from "solid-js";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { githubStore } from "../stores/github";
import { notificationsStore } from "../stores/notifications";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { isTauri } from "../transport";

/** Owns process-level polling cleanup, sleep inhibition, and focus badge clearing. */
export function useSystemLifecycle(): void {
	onCleanup(() => githubStore.stopPolling());

	let lastSleepBlocked: boolean | null = null;
	createEffect(() => {
		if (!isTauri()) return;
		const shouldBlock = settingsStore.state.preventSleepWhenBusy && terminalsStore.isAnyBusy();
		if (shouldBlock === lastSleepBlocked) return;
		lastSleepBlocked = shouldBlock;
		invoke(shouldBlock ? "block_sleep" : "unblock_sleep").catch((error) =>
			appLogger.warn("app", `Failed to ${shouldBlock ? "block" : "unblock"} sleep`, error),
		);
	});

	onMount(() => {
		const handleFocus = () => notificationsStore.clearBadge();
		window.addEventListener("focus", handleFocus);
		onCleanup(() => window.removeEventListener("focus", handleFocus));
	});
}
