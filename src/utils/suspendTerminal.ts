import { appLogger } from "../stores/appLogger";
import { paneLayoutStore } from "../stores/paneLayout";
import { type TerminalData, terminalsStore } from "../stores/terminals";
import { rpc } from "../transport";
import { clearShellFamilyCache } from "./sendCommand";

export type SuspendOutcome = { ok: true } | { ok: false; reason: string };

/** Why this tab cannot be suspended right now, or null. Ending a PTY mid-turn
 *  would cut the agent's work or an unanswered question, so busy tabs are refused. */
export function suspendRefusal(term: TerminalData): string | null {
	if (term.suspended) return "already suspended";
	if (!term.sessionId) return "no live session";
	if (term.awaitingInput) return "waiting for input";
	if (term.queuedCommands > 0) return "queued commands pending";
	if (term.agentType) {
		if (term.backgroundWork || term.agentState === "working" || term.agentState === "starting") {
			return "agent working";
		}
	} else if (term.shellState === "busy") {
		return "command running";
	}
	return null;
}

/** Tabs whose suspend is in flight. The PTY's exit event can arrive before the tab is
 *  marked suspended, and the exit and session-closed handlers must not take it for a crash. */
const suspending = new Set<string>();

export function isSuspendingOrSuspended(id: string): boolean {
	return suspending.has(id) || (terminalsStore.get(id)?.suspended ?? false);
}

/** End the tab's PTY (and its agent) but keep the tab, in the state a restart restores it in.
 *  The tab keeps agentType, agentSessionId, tuicSession, alias and cwd; `suspended` makes
 *  it persist across a restart and stops its Terminal from spawning a new PTY.
 *  `suspended` is set only once the PTY is closed: a failed close leaves the tab untouched. */
export async function suspendTerminal(id: string): Promise<SuspendOutcome> {
	if (suspending.has(id)) return { ok: false, reason: "already suspending" };
	suspending.add(id);
	try {
		return await suspendTab(id);
	} finally {
		suspending.delete(id);
	}
}

async function suspendTab(id: string): Promise<SuspendOutcome> {
	const initial = terminalsStore.get(id);
	if (!initial) return { ok: false, reason: "unknown tab" };
	const refusal = suspendRefusal(initial);
	if (refusal) return { ok: false, reason: refusal };

	const term = initial;
	const sessionId = term.sessionId as string;
	try {
		clearShellFamilyCache(sessionId);
		await rpc("suspended_session_action", {
			sessionId,
			repoPath: term.repoPath,
			cwd: term.cwd,
			request: {
				action: "suspend",
				sessionId,
				metadata: {
					name: term.name,
					agentSessionId: term.agentSessionId,
					agentLaunchCommand: term.agentLaunchCommand,
					paneSlot: paneLayoutStore.getGroupForTab(id),
				},
			},
		});
	} catch (e) {
		appLogger.warn("terminal", "Suspend: closing the PTY failed", { id, error: String(e) });
		return { ok: false, reason: "closing the session failed" };
	}
	// The tab may have been closed while close_pty was pending: there is nothing left to mark.
	if (!terminalsStore.get(id)) return { ok: false, reason: "unknown tab" };
	terminalsStore.update(id, {
		suspended: true,
		shellState: null,
		agentState: null,
		backgroundWork: false,
		standby: false,
		pendingInitCommand: null,
		pendingResumeCommand: null,
	});
	terminalsStore.setSessionId(id, null);
	return { ok: true };
}

/** Ask Rust to restore the durable tab and attach its new PTY. */
export async function resumeTerminal(id: string): Promise<SuspendOutcome> {
	const term = terminalsStore.get(id);
	if (!term?.suspended) return { ok: false, reason: "not suspended" };
	try {
		const result = await rpc<{ session_id: string }>("resume_session", {
			repoPath: term.repoPath,
			cwd: term.cwd,
			tuicSession: term.tuicSession,
		});
		terminalsStore.setSessionId(id, result.session_id);
		terminalsStore.update(id, { suspended: false, pendingInitCommand: null, pendingResumeCommand: null });
		return { ok: true };
	} catch (error) {
		appLogger.warn("terminal", "Resume failed", { id, error: String(error) });
		return { ok: false, reason: String(error) };
	}
}
