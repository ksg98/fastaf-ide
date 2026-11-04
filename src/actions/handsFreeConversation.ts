import { appLogger } from "../stores/appLogger";
import { dictationStore } from "../stores/dictation";
import { terminalsStore } from "../stores/terminals";

/** Whether a hands-free conversation is armed, as far as this client last read. */
export const isHandsFreeArmed = (): boolean => dictationStore.state.handsFree?.armed === true;

/**
 * Start or stop the hands-free conversation.
 *
 * Behind the `toggle-hands-free` Command Palette entry, and any shortcut the
 * user binds to it. Starting binds the ACTIVE terminal — the one the user is
 * looking at — and nothing else.
 *
 * Call it straight from the user gesture (the palette click or key press) and
 * never after an `await`:
 * `armHandsFree` primes the earcons synchronously, and a context primed
 * outside a gesture stays suspended, so the first earcon would be lost.
 * The same reason forbids re-reading the status first; a stale `armed` flag
 * only costs a second press, because the monitor re-reads it while armed.
 */
export function toggleHandsFreeConversation(): Promise<unknown> {
	if (isHandsFreeArmed()) return dictationStore.disarmHandsFree();
	const sessionId = terminalsStore.getActive()?.sessionId;
	if (!sessionId) {
		appLogger.warn("dictation", "Hands-free needs an active terminal with a live session");
		return Promise.resolve(false);
	}
	return dictationStore.armHandsFree(sessionId);
}
