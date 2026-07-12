import { invoke } from "../invoke";
import { isTauri } from "../transport";

/**
 * Write text to the system clipboard.
 *
 * Inside the Tauri webview we route through the native clipboard-manager plugin
 * instead of navigator.clipboard. WKWebView rejects navigator.clipboard.writeText
 * with NotAllowedError whenever the document isn't focused or the transient user
 * activation has already been consumed by an intervening await — exactly what the
 * terminal copy paths do (they await an IPC round-trip to fetch the selection text
 * before writing). The native command has no focus / user-gesture requirement.
 *
 * Browser mode has no such plugin command, so it keeps navigator.clipboard, which
 * behaves correctly in a normal (focused, secure-context) browser tab.
 *
 * Throws on failure so callers can surface a "copy failed" status.
 */
export async function writeClipboard(text: string): Promise<void> {
	if (isTauri()) {
		await invoke("plugin:clipboard-manager|write_text", { text, label: undefined });
		return;
	}
	await navigator.clipboard.writeText(text);
}
