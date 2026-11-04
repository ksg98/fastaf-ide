import { createSignal } from "solid-js";

export type MobileFontSurface = "terminal" | "chat";
export const MIN_MOBILE_FONT_SIZE = 10;
export const MAX_MOBILE_FONT_SIZE = 24;

function readFontSize(surface: MobileFontSurface, fallback: number): number {
	try {
		const saved = Number(localStorage.getItem(`tuic-mobile-${surface}-font-size`));
		return Number.isInteger(saved) && saved >= MIN_MOBILE_FONT_SIZE && saved <= MAX_MOBILE_FONT_SIZE ? saved : fallback;
	} catch {
		return fallback;
	}
}

const [terminalFontSize, setTerminalFontSize] = createSignal(readFontSize("terminal", 14));
const [chatFontSize, setChatFontSize] = createSignal(readFontSize("chat", 14));

export const mobileFontSizes = {
	terminal: terminalFontSize,
	chat: chatFontSize,
	step(surface: MobileFontSurface, step: -1 | 1): void {
		const current = surface === "terminal" ? terminalFontSize() : chatFontSize();
		const next = Math.max(MIN_MOBILE_FONT_SIZE, Math.min(MAX_MOBILE_FONT_SIZE, current + step));
		if (surface === "terminal") setTerminalFontSize(next);
		else setChatFontSize(next);
		try {
			localStorage.setItem(`tuic-mobile-${surface}-font-size`, String(next));
		} catch {
			// Storage can be unavailable in private browsing; the current view still updates.
		}
	},
};

/** Change transcript body text without changing the composer or interface type scale. */
export function mobileChatReadingStyle() {
	const size = chatFontSize();
	return { "--font-base": `${size}px` };
}
