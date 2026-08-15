import { getCurrentWebview } from "@tauri-apps/api/webview";
import { appLogger } from "./stores/appLogger";
import { settingsStore } from "./stores/settings";
import { isTauri } from "./transport";

/**
 * App-wide zoom, applied through the webview's own page zoom.
 *
 * This scales everything — chrome, panels, editors and the terminal alike —
 * because WebKit scales `devicePixelRatio` along with the zoom, so the terminal
 * canvas re-renders its backing store at the new resolution instead of being
 * stretched (measured: at zoom 1.5 on a 2x display, dpr reports 3 and the canvas
 * re-sizes to match). A CSS-token rescale could not do that — the canvas takes a
 * numeric font size, and the chrome dimensions in global.css are absolute px.
 *
 * Zoom is per-webview, so every window applies the stored level on its own boot.
 */

/** Push a zoom level into this webview. Never throws — zoom is cosmetic. */
export async function applyAppZoom(level: number): Promise<void> {
	if (!isTauri()) return;
	try {
		await getCurrentWebview().setZoom(level);
	} catch (e) {
		appLogger.warn("app", "Failed to apply app zoom", { level, error: String(e) });
	}
}

/** Apply the persisted level. Call once per window, after settings hydrate. */
export function syncAppZoom(): void {
	void applyAppZoom(settingsStore.state.appZoom);
}
