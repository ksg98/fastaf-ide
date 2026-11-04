import { requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { isTauri } from "../transport";
import type { NativeNoticeTarget } from "./nativeNotificationNavigation";

interface NativeNotice {
	title: string;
	body: string;
	key: string;
	target: NativeNoticeTarget;
	/** Re-checked after the permission await; a native notice cannot be withdrawn once sent. */
	isCurrent?: () => boolean;
	/** Send even while the window is focused; the caller has decided the user is not looking at the target. */
	ignoreFocus?: boolean;
}

const DEDUP_MS = 5_000;
const recent = new Map<string, number>();
let permission: Promise<boolean> | null = null;

async function canNotify(): Promise<boolean> {
	permission ??= (async () => {
		try {
			if ((await requestPermission()) === "granted") return true;
			appLogger.warn("app", "Native notifications permission denied");
		} catch (error) {
			appLogger.warn("app", "Could not request native notifications permission", error);
		}
		return false;
	})();
	return permission;
}

export async function showNativeNotice(notice: NativeNotice): Promise<void> {
	if (!isTauri() || (document.hasFocus() && !notice.ignoreFocus)) return;
	const now = Date.now();
	if (now - (recent.get(notice.key) ?? -Infinity) < DEDUP_MS) return;
	if (!(await canNotify()) || (document.hasFocus() && !notice.ignoreFocus) || notice.isCurrent?.() === false) return;
	// Record after permission succeeds and focus is checked again.
	const sentAt = Date.now();
	if (sentAt - (recent.get(notice.key) ?? -Infinity) < DEDUP_MS) return;
	for (const [key, at] of recent) if (sentAt - at >= DEDUP_MS) recent.delete(key);
	recent.set(notice.key, sentAt);
	try {
		if (navigator.userAgent.includes("Macintosh")) {
			await invoke("show_native_notification", { title: notice.title, body: notice.body, target: notice.target });
		} else {
			sendNotification({ title: notice.title, body: notice.body });
		}
	} catch (error) {
		recent.delete(notice.key);
		appLogger.warn("app", "Could not send native notification", error);
	}
}
