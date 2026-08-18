/**
 * macOS keeps a set of Control-based combos for itself: Mission Control, App
 * Exposé and Spaces switching all live on `Control` plus an arrow. `fn` + arrow
 * arrives as Home/End/PageUp/PageDown, so `fn + ctrl + ←` reaches the web view
 * as `Ctrl+Home`.
 *
 * Any handler that calls `preventDefault()` on one of these kills the system
 * binding for as long as it holds focus — a prevented keydown never reaches
 * AppKit. The terminal already yields them (see `isSystemReservedKey` in
 * terminalInput.ts, which delegates here); CodeMirror does not: its
 * `defaultKeymap` binds `Ctrl-ArrowLeft/Right` to cursorSyntaxLeft/Right on
 * macOS and `standardKeymap` claims `Ctrl-ArrowUp/Down`, each of which returns
 * handled and therefore prevents the default. With an editor tab focused —
 * which is most of the time once files are open beside the terminal — Spaces
 * and Mission Control silently stopped working.
 *
 * Terminal.app, iTerm and VS Code all pass these through: the system claims
 * them first, so yielding is parity rather than a lost capability.
 */

// Arrows and their fn-forms only. The terminal's old predicate also yielded
// Ctrl+Insert and Ctrl+Delete, which macOS does not bind to anything — those now
// reach the PTY as ordinary modified nav keys, matching Terminal.app.
const SYSTEM_RESERVED_KEYS = new Set([
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	// `fn` + arrow on Apple keyboards
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

/** True when macOS resolves this combo itself and the app must not consume it. */
export function isMacSystemReservedKey(e: KeyboardEvent, mac: boolean): boolean {
	if (!mac || !e.ctrlKey || e.metaKey) return false;
	return SYSTEM_RESERVED_KEYS.has(e.key);
}

/**
 * Stop system-reserved combos before they reach a CodeMirror instance mounted
 * under `host`.
 *
 * Capture phase on the host runs ahead of CodeMirror's own listener on the
 * (descendant) content element, and `stopImmediatePropagation` keeps the keymap
 * from ever seeing the event — so nothing calls `preventDefault` and WebKit
 * hands the key to AppKit. Propagation is a DOM concern only; suppressing it
 * does not suppress the native default action, which is exactly what we want.
 *
 * Returns a cleanup function.
 */
export function passThroughMacSystemKeys(host: HTMLElement, mac: boolean): () => void {
	const onKeydown = (e: KeyboardEvent) => {
		if (isMacSystemReservedKey(e, mac)) e.stopImmediatePropagation();
	};
	host.addEventListener("keydown", onKeydown, true);
	return () => host.removeEventListener("keydown", onKeydown, true);
}
