import { activityStore } from "../../stores/activityStore";
import { toastsStore } from "../../stores/toasts";

/** Release dismiss timers and persist the activity mirrored by real toasts. */
export function cleanupToasts(): void {
	for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
	activityStore.flushSave();
}
