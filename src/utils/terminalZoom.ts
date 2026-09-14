import { terminalsStore } from "../stores/terminals";

/** Terminal zoom bounds, shared by every path that changes a terminal's font
 *  size — keyboard, native menu, command palette, floating window and pinch.
 *  They were declared three times over; a pinch that clamps differently from a
 *  keypress is a bug waiting to be found by a user, not by a test. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export const FONT_STEP = 2;

export function clampFontSize(fontSize: number): number {
	return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize));
}

/**
 * Apply a pinch gesture's font-size delta to one terminal.
 *
 * The size lives per terminal, exactly as the keyboard path writes it. Writing
 * the global default instead both leaked one terminal's gesture into every
 * other terminal (and into the persisted config) and left the pinched terminal
 * unchanged, because the renderer reads the per-terminal size first.
 *
 * A pinch fires on every touchmove, so a delta too small to change the rounded
 * size writes nothing at all.
 */
export function applyPinchFontDelta(terminalId: string, delta: number, defaultFontSize: number): void {
	const current = terminalsStore.get(terminalId)?.fontSize ?? defaultFontSize;
	const next = clampFontSize(Math.round(current + delta));
	if (next === current) return;
	terminalsStore.setFontSize(terminalId, next);
}
