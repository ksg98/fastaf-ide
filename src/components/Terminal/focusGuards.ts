/**
 * True when the caret sits in a text field that belongs to THIS terminal but is
 * not the canvas key-input — the search bar or the compose panel.
 *
 * Both render inside the terminal wrapper, which carries `data-focus-target="terminal"`,
 * so every "focus the terminal" path (visibility auto-focus, overlay unmount
 * restore, repo-switch restore) sees them as the terminal itself and calls
 * `canvasTerminalRef().focus()` — pulling the caret out from under the user
 * mid-keystroke (#ce43).
 *
 * Lives in its own module rather than as a closure so the rule is testable
 * without mounting the whole terminal, and so any future restore path can reuse
 * the same definition instead of re-deriving it.
 */
export function focusIsInsideOwnInput(active: Element | null, terminalId: string): boolean {
	if (!(active instanceof HTMLElement)) return false;
	if (!active.matches("input, textarea, [contenteditable='true']")) return false;
	if (active.closest<HTMLElement>("[data-terminal-id]")?.dataset.terminalId !== terminalId) return false;
	// CanvasTerminal's hidden key-input IS the terminal, not a competing field:
	// refusing to focus it would break normal auto-focus entirely.
	return active.closest("[data-terminal-container]") === null;
}
