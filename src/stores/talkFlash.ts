import { createSignal } from "solid-js";

/** How long the ring around a terminal takes to fade; the CSS animation matches. */
export const TALK_FLASH_MS = 1800;

const [terminalId, setTerminalId] = createSignal<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * The terminal talk mode just acted in.
 *
 * Voice gives no visual link between "I said it" and "it happened over
 * there"; the terminal pane reads this and rings itself once. A leaf module on
 * purpose: the terminal component must not import the conversation to learn it.
 */
export const talkFlash = {
	terminalId,
	flash(id: string): void {
		if (timer) clearTimeout(timer);
		setTerminalId(id);
		timer = setTimeout(() => {
			timer = undefined;
			setTerminalId(null);
		}, TALK_FLASH_MS);
	},
	clear(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
		setTerminalId(null);
	},
};
