import { toastsStore } from "../stores/toasts";

/**
 * A user-initiated action failed: keep the status-bar line and raise a sticky
 * error card that stays until dismissed. Background and programmatic failures
 * call `setStatusInfo` alone — nobody is waiting on them.
 */
export function reportActionError(
	setStatusInfo: (message: string) => void,
	message: string,
	action?: { label: string; onClick: () => void },
): void {
	setStatusInfo(message);
	toastsStore.add("Action failed", message, "error", false, action);
}
