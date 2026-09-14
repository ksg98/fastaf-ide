/**
 * Read the text selection from whichever document currently has focus.
 *
 * `window.getSelection()` only sees the host document. Text highlighted inside a
 * panel iframe (plugin dashboards like build-cleaner, HTML previews, srcdoc
 * panels) lives in that iframe's own document, so the host copy path finds
 * nothing and Cmd+C silently does nothing — the native Edit > Copy accelerator
 * (menu.rs) has already swallowed the keystroke, so WebKit never runs its own
 * copy either.
 *
 * srcdoc plugin panels are same-origin (`sandbox="allow-scripts
 * allow-same-origin"`), so we can walk the activeElement chain into them.
 * URL-mode panels are cross-origin by design: `contentDocument` is null or
 * throws, and we bail out — the browser handles those selections itself.
 */

/** Depth cap for the frame walk — panels never nest this deep. */
const MAX_FRAME_DEPTH = 5;

/**
 * Selection text from the deepest focused same-origin frame, or `""` when focus
 * is not inside a frame (or the frame is cross-origin / has nothing selected).
 */
export function getFocusedFrameSelection(root: Document = document): string {
	let doc = root;
	for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
		const el = doc.activeElement;
		if (el?.tagName !== "IFRAME") break;
		let inner: Document | null = null;
		try {
			inner = (el as HTMLIFrameElement).contentDocument;
		} catch {
			// Cross-origin frame — not readable, and not ours to copy from.
			return "";
		}
		if (!inner) return "";
		doc = inner;
	}
	if (doc === root) return "";
	return doc.defaultView?.getSelection()?.toString() ?? "";
}
