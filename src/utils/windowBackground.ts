import { appLogger } from "../stores/appLogger";
import { isTauri } from "../transport";

// Serialize the SDK's window + webview pair so a slower previous theme cannot
// finish after the current one and leave the two backing layers out of sync.
let pending = Promise.resolve();
export function syncWindowBackground(color: string): void {
	if (!isTauri()) return;
	pending = pending
		.then(async () => {
			const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
			await getCurrentWebviewWindow().setBackgroundColor(color);
		})
		.catch((error: unknown) => {
			appLogger.warn("app", "Failed to sync native window background", { error });
		});
}
