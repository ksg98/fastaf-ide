import { appLogger } from "../../stores/appLogger";
import { toastsStore } from "../../stores/toasts";

const FAILURE_TITLE = {
	send: "Could not send the command",
	enqueue: "Could not queue the command",
} as const;

/**
 * Run one compose-panel submit against the terminal's PTY session.
 *
 * Rejects, after a toast, when the terminal has no session yet (still spawning,
 * or reconnecting) or when the call fails. A pinned panel empties its editor
 * only on success, so a rejection is what keeps a message nobody received.
 */
export async function submitCompose(
	kind: keyof typeof FAILURE_TITLE,
	sessionId: string | null,
	run: (sessionId: string) => Promise<void>,
): Promise<void> {
	try {
		if (!sessionId) throw new Error("The terminal has no running session");
		await run(sessionId);
	} catch (err) {
		appLogger.error("terminal", `ComposePanel ${kind} failed`, { sessionId, error: err });
		toastsStore.add(FAILURE_TITLE[kind], err instanceof Error ? err.message : String(err), "error");
		throw err;
	}
}
