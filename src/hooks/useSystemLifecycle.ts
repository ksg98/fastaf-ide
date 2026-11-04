import { onCleanup, onMount } from "solid-js";
import { githubStore } from "../stores/github";
import { notificationsStore } from "../stores/notifications";

/** Owns process-level polling cleanup and focus badge clearing. */
export function useSystemLifecycle(): void {
	onCleanup(() => githubStore.stopPolling());

	onMount(() => {
		const handleFocus = () => notificationsStore.clearBadge();
		window.addEventListener("focus", handleFocus);
		onCleanup(() => window.removeEventListener("focus", handleFocus));
	});
}
