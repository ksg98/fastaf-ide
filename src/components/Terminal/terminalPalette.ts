import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";

/**
 * Publishes the resolved terminal theme to the backend so the emulator can
 * answer OSC 10/11/12 colour queries.
 *
 * Why the backend needs this at all: an app that asks "what colour is your
 * background?" uses `OSC 11 ; ? ST` followed by `ESC[c` as a fence — DA is
 * universally supported, so a DA reply arriving with no colour reply is meant to
 * mean "this terminal cannot answer". A terminal that stays silent therefore
 * does not read as "no": the probe never concludes and simply retries. Claude
 * Code retried every ~1.2 s for the whole life of a session, and each DA reply
 * it triggered was written into the PTY as if typed.
 *
 * So this is not cosmetic polish. Silence is the expensive answer.
 */

export type Rgb = [number, number, number];

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
// Channels accept a sign so `clampChannel` actually sees the out-of-range values
// it promises to clamp; a regex that could only match 0..n would make the lower
// bound dead code.
const RGB_FUNC = /^rgba?\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/i;

function clampChannel(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Parse the CSS colours our theme variables actually hold: `#abc`, `#aabbcc`,
 * and `rgb()`/`rgba()`. Returns null for anything else — a wrong colour is worth
 * reporting, but an invented one is not, so callers fall back to their default.
 */
export function cssColorToRgb(value: string): Rgb | null {
	const text = value.trim();
	if (!text) return null;

	const short = HEX_SHORT.exec(text);
	if (short) {
		return [
			Number.parseInt(short[1] + short[1], 16),
			Number.parseInt(short[2] + short[2], 16),
			Number.parseInt(short[3] + short[3], 16),
		];
	}

	const long = HEX_LONG.exec(text);
	if (long) {
		return [Number.parseInt(long[1], 16), Number.parseInt(long[2], 16), Number.parseInt(long[3], 16)];
	}

	const func = RGB_FUNC.exec(text);
	if (func) {
		return [clampChannel(Number(func[1])), clampChannel(Number(func[2])), clampChannel(Number(func[3]))];
	}

	return null;
}

/** Serialized last-published palette, so a remeasure storm sends nothing new. */
let lastPublished: string | null = null;

/**
 * Send the palette to the backend, at most once per actual change.
 *
 * Every CanvasTerminal resolves the same theme variables and calls this on
 * remeasure, so without the guard a resize would publish once per open tab.
 */
export function publishTerminalPalette(foreground: Rgb, background: Rgb, cursor: Rgb): void {
	const key = `${foreground.join()}|${background.join()}|${cursor.join()}`;
	if (key === lastPublished) return;
	lastPublished = key;

	invoke("set_terminal_theme_colors", { foreground, background, cursor }).catch((error) => {
		// Leave lastPublished set: a retry storm on a backend that is refusing
		// would be worse than reporting a stale palette. The next real theme
		// change publishes again.
		appLogger.warn("terminal", "Publishing the terminal palette failed", { error: String(error) });
	});
}

/** Test seam: forget what was published so a fresh case starts clean. */
export function resetPublishedPaletteForTests(): void {
	lastPublished = null;
}
