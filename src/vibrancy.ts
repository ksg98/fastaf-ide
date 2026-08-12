/**
 * Opt the webview into the translucent look.
 *
 * The macOS window is transparent with an `underWindowBackground` material
 * behind it (tauri.macos.conf.json / `with_vibrancy` in Rust), but every
 * surface renders opaque until `.vibrancy` lands on <html> — the gloss tokens
 * in global.css only take their rgba/blur values under that class. That split
 * is deliberate: it makes "reduce transparency" a live toggle with no Rust
 * round-trip (an opaque body fully hides the native material), keeps
 * non-macOS platforms opaque without a separate stylesheet, and lets the OS
 * `prefers-reduced-transparency` preference collapse the same tokens on its
 * own.
 */
import { settingsStore } from "./stores/settings";

const isMac = (): boolean =>
	typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** Apply the current vibrancy state; call once per webview after settings load. */
export function syncVibrancy(): void {
	const on = isMac() && !settingsStore.state.reduceTransparency;
	document.documentElement.classList.toggle("vibrancy", on);
}
