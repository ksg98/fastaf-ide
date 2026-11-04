import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { terminalsStore } from "../stores/terminals";
import { toastsStore } from "../stores/toasts";
import { getShellFamily, sendCommand } from "./sendCommand";

/** Send text to a specific PTY session as a command, routed through the
 *  canonical `sendCommand` (agent-aware split Enter for Ink raw mode,
 *  bracketed-paste for multi-line, Windows-native Ctrl-U skip).
 *
 *  Uses the smart `invoke` wrapper so it works in both Tauri and browser modes.
 *  Bypassing `sendCommand` (raw `write_pty` text + "\r") submits in browser
 *  thanks to the per-session HTTP write-queue gap, but NOT in Tauri — the back-
 *  to-back IPC writes land in one PTY read chunk and Ink swallows the Enter. */
export async function sendTextToSession(sessionId: string, text: string, submit = true): Promise<void> {
	const agentType = terminalsStore.getAgentTypeForSession(sessionId);
	const shellFamily = await getShellFamily(sessionId);
	await sendCommand(
		(data) => invoke("write_pty", { sessionId, data }),
		text,
		agentType,
		shellFamily,
		submit,
		sessionId,
	);
}

/** Send text to the currently-active terminal as a command.
 *
 *  Shared by the Notes panel "Send to Terminal" action in both its attached
 *  (PanelOrchestrator) and detached (notes panel adapter) forms so the two
 *  paths can never drift. No-op when there is no active PTY session. */
export async function sendTextToActiveTerminal(text: string): Promise<void> {
	const active = terminalsStore.getActive();
	const sessionId = active?.sessionId;
	if (!sessionId) return;
	try {
		await sendTextToSession(sessionId, text);
	} catch (err) {
		appLogger.error("network", `Send to terminal failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	requestAnimationFrame(() => active?.ref?.focus());
}

/** True when the active terminal runs a detected agent, the only kind of
 *  session with an idle window to drain a queue into. */
export function canQueueToActiveTerminal(): boolean {
	return !!terminalsStore.getActive()?.agentType;
}

/** Leave text for the active agent's next idle window instead of typing it
 *  into the prompt now — the same FIFO the Compose panel enqueues into.
 *
 *  Returns false when there is no agent session to queue for, or when the
 *  backend refused; the caller decides what to tell the user. */
export async function queueTextToActiveTerminal(text: string): Promise<boolean> {
	const active = terminalsStore.getActive();
	const sessionId = active?.sessionId;
	if (!sessionId || !active.agentType) {
		toastsStore.add("Nothing to queue for", "The active tab is not running an agent.", "error");
		return false;
	}
	try {
		const outcome = await invoke<{ typed: boolean; queued: number }>("enqueue_agent_command", {
			sessionId,
			text,
		});
		// Trust the call's own count rather than the 1s lifecycle poll, so the
		// Compose badge reacts to this click like it does to its own.
		terminalsStore.update(active.id, { queuedCommands: outcome.queued });
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		appLogger.error("network", `Queue to terminal failed: ${message}`);
		toastsStore.add("Could not queue the idea", message, "error");
		return false;
	}
}
