import { createSignal } from "solid-js";

/** What the mounted dock lets a terminal ask of it. */
export interface ComposeDockHandle {
	/**
	 * Open the card and put the caret in its field. `insert` goes in at the
	 * caret; `replace` swaps the whole draft (a smart prompt, say). Returns false
	 * when the dock cannot take text right now (no terminal to send to).
	 */
	open(text?: { insert?: string; replace?: string }): boolean;
}

let handle: ComposeDockHandle | null = null;
const [present, setPresent] = createSignal(false);

/**
 * The dock under the terminal column is FastAF's one input for the active
 * terminal. A terminal asks here whether it is on screen before drawing a text
 * box of its own: the Chat view only brings back upstream's composer where
 * there is no dock (a detached terminal window), so an agent never has two.
 */
export const composeDockBridge = {
	/** True while the dock (not the hero) is mounted. Reactive. */
	present,

	/** The dock registers itself on mount; the returned function unregisters it. */
	register(next: ComposeDockHandle): () => void {
		handle = next;
		setPresent(true);
		return () => {
			if (handle !== next) return;
			handle = null;
			setPresent(false);
		};
	},

	/** Open the dock with the caret in its field. False when there is no dock or it cannot take text. */
	open(text?: { insert?: string; replace?: string }): boolean {
		return handle?.open(text) ?? false;
	},
};
