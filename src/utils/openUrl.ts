import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { isTauri } from "../transport";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Open a URL in the system browser, using Tauri shell in native mode or window.open in browser mode.
 *  Only allows http/https/mailto schemes — terminal output is untrusted and arbitrary
 *  URI schemes (file://, smb://, custom protocols) could invoke OS handlers. */
export function handleOpenUrl(url: string): void {
	try {
		const parsed = new URL(url);
		if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
			appLogger.warn("app", `Blocked URL with disallowed scheme: ${parsed.protocol}${url.slice(0, 80)}`);
			return;
		}
	} catch {
		appLogger.warn("app", `Blocked malformed URL: ${url.slice(0, 80)}`);
		return;
	}
	if (isTauri()) {
		invoke("open_default_app", { target: url, kind: "url" }).catch((err) =>
			appLogger.error("app", "Failed to open URL", err),
		);
	} else {
		window.open(url, "_blank");
	}
}

/**
 * Open a local file or directory with the OS default application.
 *
 * Deliberately NOT `handleOpenUrl`. That allowlist exists because terminal
 * output is untrusted: a `file://` scraped off a PTY could name anything and
 * hand it to an OS handler. A path the app already holds is not that input — the
 * tab is rendering the file's contents on screen — and blocking it there only
 * produced a menu item that silently did nothing. Route the trusted case through
 * its own door instead of widening the guard on the untrusted one.
 */
export function openLocalPath(path: string): void {
	if (!isTauri()) {
		appLogger.warn("app", `Cannot open a local path in browser mode: ${path.slice(0, 120)}`);
		return;
	}
	invoke("open_default_app", { target: path, kind: "path" }).catch((err) =>
		appLogger.error("app", "Failed to open path externally", { path, error: String(err) }),
	);
}
