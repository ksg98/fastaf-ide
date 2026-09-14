import { terminalsStore } from "../../stores/terminals";

/**
 * Decide whether a backend `question-cleared` may drop the awaiting badge.
 *
 * The backend emits it when the silence timer finds the tracked question gone
 * from the screen — the backstop for an answer we never saw (a bare Enter emits
 * no `user-input`). Two states must survive it:
 *
 * - `awaitingInputConfident` — grok and friends repaint while they wait, so
 *   absence from one frame is not proof that the user replied.
 * - any badge that is not `"question"` — `"error"` is set by the frontend alone
 *   (usage-exhausted, api-error) and the backend knows nothing about it, so a
 *   question retraction must never wipe it.
 */
export function shouldRetractAwaiting(opts: {
	awaitingInput: string | null | undefined;
	awaitingInputConfident: boolean;
}): boolean {
	return opts.awaitingInput === "question" && !opts.awaitingInputConfident;
}

/** Apply one parsed `question-cleared` event through the store path Terminal uses. */
export function handleQuestionCleared(terminalId: string): void {
	const terminal = terminalsStore.get(terminalId);
	if (
		shouldRetractAwaiting({
			awaitingInput: terminal?.awaitingInput,
			awaitingInputConfident: terminal?.awaitingInputConfident ?? false,
		})
	) {
		terminalsStore.clearAwaitingInput(terminalId);
	}
}
